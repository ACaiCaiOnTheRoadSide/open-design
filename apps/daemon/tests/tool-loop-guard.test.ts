import { describe, expect, it } from 'vitest';
import {
  computeToolSignature,
  createToolLoopGuard,
  displayToolSignature,
  isProgressSuccess,
  isReadOnlyShellCommand,
  maskedOdCliFailure,
  resolveToolLoopMode,
} from '../src/tool-loop-guard.js';

// Drive a guard through a use+result pair the way the run loop does.
function fail(guard: ReturnType<typeof createToolLoopGuard>, id: string, name: string, input: unknown) {
  guard.observeToolUse(id, name, input);
  return guard.observeToolResult(id, true, 'boom');
}
function ok(guard: ReturnType<typeof createToolLoopGuard>, id: string, name: string, input: unknown) {
  guard.observeToolUse(id, name, input);
  return guard.observeToolResult(id, false, '');
}

describe('computeToolSignature', () => {
  it('uses the command for Bash', () => {
    expect(computeToolSignature('Bash', { command: 'ls -la' })).toBe('Bash ls -la');
  });

  it('uses file_path (and old_string) for Edit so different edits to one file differ', () => {
    const a = computeToolSignature('Edit', { file_path: '/a.html', old_string: 'foo' });
    const b = computeToolSignature('Edit', { file_path: '/a.html', old_string: 'bar' });
    expect(a).not.toBe(b);
    expect(a).toContain('/a.html');
  });

  it('collapses whitespace so trivially reformatted actions match', () => {
    expect(computeToolSignature('Bash', { command: 'ls   -la\n' })).toBe(
      computeToolSignature('Bash', { command: 'ls -la' }),
    );
  });

  it('falls back to the tool name when input has nothing usable', () => {
    expect(computeToolSignature('ExitPlanMode', {})).toBe('ExitPlanMode');
    expect(computeToolSignature('Bash', null)).toBe('Bash');
  });

  it('keeps the full signature for counting and truncates only for display', () => {
    const full = computeToolSignature('Bash', { command: 'x'.repeat(1000) });
    expect(full.length).toBeGreaterThan(160); // full-fidelity dedup key, not capped
    const shown = displayToolSignature(full);
    expect(shown.length).toBeLessThanOrEqual(160);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('does not collide two distinct long commands sharing a 160-char prefix', () => {
    const prefix = 'run '.repeat(60); // 240 chars, well over the display cap
    const a = computeToolSignature('Bash', { command: `${prefix}alpha` });
    const b = computeToolSignature('Bash', { command: `${prefix}beta` });
    expect(a).not.toBe(b);
    // ...and their truncated display forms DO collide, which is exactly why the
    // display string must not be used as the counting key.
    expect(displayToolSignature(a)).toBe(displayToolSignature(b));
  });
});

describe('createToolLoopGuard — repeated-failure trigger', () => {
  it('warns when the same failing action repeats warnRepeat times', () => {
    const guard = createToolLoopGuard();
    const input = { command: 'python3 verify.py' };
    expect(fail(guard, 't1', 'Bash', input)).toBeNull(); // 1
    expect(fail(guard, 't2', 'Bash', input)).toBeNull(); // 2
    expect(fail(guard, 't3', 'Bash', input)).toBeNull(); // 3
    const verdict = fail(guard, 't4', 'Bash', input); // 4 → warn
    expect(verdict).toMatchObject({
      type: 'tool_loop',
      reason: 'repeated-failure',
      action: 'warn',
      toolName: 'Bash',
      count: 4,
    });
    expect(guard.warned).toBe(true);
    expect(guard.halted).toBe(false);
  });

  it('halts when the same failing action repeats haltRepeat times', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    const input = { file_path: '/x.html', old_string: 'titlebar-left' };
    let halt = null;
    for (let i = 0; i < 8; i += 1) halt = fail(guard, `t${i}`, 'Edit', input);
    expect(halt).toMatchObject({ reason: 'repeated-failure', action: 'halt', count: 8 });
    expect(guard.halted).toBe(true);
  });

  it('does not warn on a few legitimate retries of the same action', () => {
    const guard = createToolLoopGuard();
    const input = { command: 'pnpm build' };
    expect(fail(guard, 'a', 'Bash', input)).toBeNull();
    expect(fail(guard, 'b', 'Bash', input)).toBeNull();
    expect(ok(guard, 'c', 'Bash', input)).toBeNull(); // fixed it
    expect(guard.warned).toBe(false);
  });

  it('does not halt when the same check keeps failing but successful edits land between attempts', () => {
    // The progressing-run case the cumulative counter wrongly halted (PR #3375
    // review): rerun the same verification command after each successful edit,
    // each run failing on the next newly-written case. The intervening success
    // is real progress, so the repeated-failure tally must not accumulate.
    const guard = createToolLoopGuard({ mode: 'halt' });
    const check = { command: 'pnpm test' };
    let tripped = null;
    for (let i = 0; i < 12; i += 1) {
      const verdict = fail(guard, `chk-${i}`, 'Bash', check); // same failing check
      if (verdict) tripped = verdict;
      ok(guard, `edit-${i}`, 'Edit', { file_path: '/src/a.ts', old_string: `case-${i}` }); // progress
    }
    expect(tripped).toBeNull();
    expect(guard.warned).toBe(false);
    expect(guard.halted).toBe(false);
  });

  it('still halts when the same failing call is interleaved with successful read-only calls', () => {
    // The false negative that clearing failCounts on EVERY success let through
    // (PR #3375 review): a stuck agent re-reads the file and retries the same
    // wrong assumption. A successful Read is not progress on the failing action,
    // so the repeated-failure tally must survive it and the loop must still trip.
    const guard = createToolLoopGuard({ mode: 'halt' });
    const failing = { command: "python3 -c \"assert 'titlebar-left' in open('v.html').read()\"" };
    for (let i = 0; i < 8; i += 1) {
      fail(guard, `chk-${i}`, 'Bash', failing); // same failing verification
      ok(guard, `read-${i}`, 'Read', { file_path: '/v.html' }); // read-only, NOT progress
    }
    expect(guard.halted).toBe(true);
  });

  it('a successful mutating tool clears the tally but a successful read does not', () => {
    const failing = { command: 'pnpm test' };
    // Read between failures: tally survives -> trips.
    const reads = createToolLoopGuard();
    for (let i = 0; i < 4; i += 1) {
      fail(reads, `f-${i}`, 'Bash', failing);
      ok(reads, `r-${i}`, 'Read', { file_path: '/x' });
    }
    expect(reads.warned).toBe(true);
    // Edit between failures: tally clears each round -> never trips.
    const edits = createToolLoopGuard();
    for (let i = 0; i < 4; i += 1) {
      fail(edits, `f-${i}`, 'Bash', failing);
      ok(edits, `e-${i}`, 'Edit', { file_path: '/x', old_string: `case-${i}` });
    }
    expect(edits.warned).toBe(false);
  });

  it('does not halt when a failing check is fixed by successful mutating Bash between attempts', () => {
    // PR #3375 review: agents change state through the shell, so a successful
    // `sed -i` (or install/build/git commit) between failing checks is real
    // progress and must clear the tally even though the tool is Bash.
    const guard = createToolLoopGuard({ mode: 'halt' });
    const check = { command: 'pnpm test' };
    let tripped = null;
    for (let i = 0; i < 12; i += 1) {
      const verdict = fail(guard, `chk-${i}`, 'Bash', check); // same failing check
      if (verdict) tripped = verdict;
      ok(guard, `fix-${i}`, 'Bash', { command: `sed -i 's/old/new/' src/file-${i}.ts` }); // shell fix = progress
    }
    expect(tripped).toBeNull();
    expect(guard.halted).toBe(false);
    expect(guard.warned).toBe(false);
  });

  it('does not halt when a failing check is fixed by a successful inline python/node script', () => {
    // PR #3375 review: an inline `python3 -c` / `node -e` snippet can write
    // files, so a successful one is a real fix and must clear the tally.
    const guard = createToolLoopGuard({ mode: 'halt' });
    const check = { command: 'pnpm test' };
    let tripped = null;
    for (let i = 0; i < 12; i += 1) {
      const verdict = fail(guard, `chk-${i}`, 'Bash', check);
      if (verdict) tripped = verdict;
      ok(guard, `fix-${i}`, 'Bash', { command: `python3 -c "open('f-${i}.ts','w').write('x')"` }); // inline write = progress
    }
    expect(tripped).toBeNull();
    expect(guard.halted).toBe(false);
  });

  it('does not halt when an env-prefixed mutating Bash fix lands between failing checks', () => {
    // PR #3375 review: `env CI=1 sed -i ...` and `env NODE_ENV=production pnpm install`
    // mutate via the wrapped command, not via `env`. The classifier must unwrap the
    // env prefix so a successful fix clears the tally, instead of reading it as a
    // read-only `env` inspection that lets stale failures accumulate to a halt.
    const guard = createToolLoopGuard({ mode: 'halt' });
    const check = { command: 'pnpm test' };
    let tripped = null;
    for (let i = 0; i < 12; i += 1) {
      const verdict = fail(guard, `chk-${i}`, 'Bash', check); // same failing check
      if (verdict) tripped = verdict;
      const fix = i % 2 === 0
        ? `env CI=1 sed -i 's/old/new/' src/file-${i}.ts`
        : 'env NODE_ENV=production pnpm install';
      ok(guard, `fix-${i}`, 'Bash', { command: fix }); // env-wrapped fix = progress
    }
    expect(tripped).toBeNull();
    expect(guard.halted).toBe(false);
    expect(guard.warned).toBe(false);
  });
});

describe('isReadOnlyShellCommand / isProgressSuccess', () => {
  it('classifies pure inspections as read-only', () => {
    for (const cmd of [
      'cat x.ts', 'ls -la', 'grep foo x', 'rg needle', 'wc -l x', 'sed -n p x',
      'git status', 'git diff HEAD', 'find . -name x',
      'env', 'env FOO=1 cat x', // bare env / env-wrapped inspection stays read-only
    ]) {
      expect(isReadOnlyShellCommand(cmd)).toBe(true);
    }
  });

  it('classifies state-changing shell commands as not read-only', () => {
    for (const cmd of [
      'sed -i s/a/b/ x', 'mv a b', 'rm x', 'mkdir y', 'pnpm install', 'npm run build',
      'git commit -m x', 'git add .', 'echo hi > f.txt',
      'python3 -c "open(\'x\',\'w\').write(\'1\')"', 'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"',
      'env CI=1 sed -i s/a/b/ x', 'env NODE_ENV=production pnpm install', // env prefix must unwrap to the real cmd
    ]) {
      expect(isReadOnlyShellCommand(cmd)).toBe(false);
    }
  });

  // PR #3375 review: mutating Bash fixes that were misclassified as read-only,
  // so in halt mode a run actually changing files could still be terminated.
  it('treats mutating find actions and unparseable segment heads as progress', () => {
    for (const cmd of [
      "find . -name '*.pyc' -delete", // -delete mutates
      'find . -exec rm {} \\;',       // -exec runs a command
      'find . -execdir rm {} ;',
      "find . -name x -fprint out.txt",
      "find . -name '*.ts' -fprint0 out.bin", // -fprint0 writes a file too
      'find . -fprintf out.txt "%p\\n"',
      '(sed -i s/a/b/ x.ts) && cat x.ts', // subshell head does not parse
      '"sed" -i s/a/b/ x',                // quoted head does not parse
    ]) {
      expect(isReadOnlyShellCommand(cmd)).toBe(false);
    }
  });

  it('keeps pure find and trailing separators read-only', () => {
    for (const cmd of [
      "find . -type f -name '*.ts'", // inspection only
      'find . -maxdepth 2 -name x',
      'ls;',          // trailing separator yields an empty segment, not a mutation
      'cat x.ts ;',
    ]) {
      expect(isReadOnlyShellCommand(cmd)).toBe(true);
    }
  });

  it('treats a Bash fix as progress and a Bash read or read-only tool as non-progress', () => {
    expect(isProgressSuccess('Bash', 'Bash sed -i s/a/b/ x')).toBe(true);
    expect(isProgressSuccess('Bash', 'Bash cat x')).toBe(false);
    expect(isProgressSuccess('Read', 'Read /x')).toBe(false);
    expect(isProgressSuccess('Edit', 'Edit /x')).toBe(true);
  });
});

describe('createToolLoopGuard — consecutive-errors trigger', () => {
  it('warns after warnConsecutive different failing actions in a row', () => {
    const guard = createToolLoopGuard();
    let verdict = null;
    for (let i = 0; i < 5; i += 1) {
      verdict = fail(guard, `t${i}`, 'Bash', { command: `try-${i}` }); // all distinct signatures
    }
    expect(verdict).toMatchObject({ reason: 'consecutive-errors', action: 'warn', count: 5 });
  });

  it('resets the consecutive streak on a successful tool call', () => {
    const guard = createToolLoopGuard();
    for (let i = 0; i < 4; i += 1) fail(guard, `t${i}`, 'Bash', { command: `try-${i}` });
    ok(guard, 'good', 'Bash', { command: 'works' }); // progress resets streak
    const verdict = fail(guard, 'after', 'Bash', { command: 'try-after' });
    expect(verdict).toBeNull();
    expect(guard.warned).toBe(false);
  });

  it('halts after haltConsecutive failures in a row', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    let last = null;
    for (let i = 0; i < 10; i += 1) last = fail(guard, `t${i}`, 'Bash', { command: `distinct-${i}` });
    expect(last).toMatchObject({ reason: 'consecutive-errors', action: 'halt', count: 10 });
    expect(guard.halted).toBe(true);
  });
});

describe('createToolLoopGuard — latching and modes', () => {
  it('emits warn at most once, then escalates to halt once', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    const input = { command: 'same' };
    const verdicts = [];
    for (let i = 0; i < 12; i += 1) {
      const v = fail(guard, `t${i}`, 'Bash', input);
      if (v) verdicts.push(v.action);
    }
    expect(verdicts).toEqual(['warn', 'halt']);
  });

  it('warn mode never halts', () => {
    const guard = createToolLoopGuard({ mode: 'warn' });
    const input = { command: 'same' };
    let sawHalt = false;
    for (let i = 0; i < 20; i += 1) {
      const v = fail(guard, `t${i}`, 'Bash', input);
      if (v?.action === 'halt') sawHalt = true;
    }
    expect(sawHalt).toBe(false);
    expect(guard.warned).toBe(true);
    expect(guard.halted).toBe(false);
  });

  it('off mode never trips', () => {
    const guard = createToolLoopGuard({ mode: 'off' });
    const input = { command: 'same' };
    for (let i = 0; i < 30; i += 1) expect(fail(guard, `t${i}`, 'Bash', input)).toBeNull();
    expect(guard.warned).toBe(false);
    expect(guard.halted).toBe(false);
  });

  it('defaults to warn: it warns but never halts', () => {
    const guard = createToolLoopGuard(); // no mode -> warn (the daemon default)
    const input = { command: 'same' };
    for (let i = 0; i < 20; i += 1) fail(guard, `t${i}`, 'Bash', input);
    expect(guard.warned).toBe(true);
    expect(guard.halted).toBe(false);
  });

  it('is inert after halting', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    const input = { command: 'same' };
    for (let i = 0; i < 8; i += 1) fail(guard, `t${i}`, 'Bash', input);
    expect(guard.halted).toBe(true);
    expect(fail(guard, 'after', 'Bash', input)).toBeNull();
  });

  it('reproduces the titlebar-left loop: repeated failing assertion halts the run', () => {
    // The exact shape that motivated the guard: the agent re-runs the same
    // shell assertion against an element name that does not exist.
    const guard = createToolLoopGuard({ mode: 'halt' });
    const cmd = { command: "python3 -c \"assert 'titlebar-left' in open('v.html').read()\"" };
    const actions: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const v = fail(guard, `loop-${i}`, 'Bash', cmd);
      if (v) actions.push(v.action);
    }
    expect(actions).toContain('warn');
    expect(actions).toContain('halt');
    expect(guard.halted).toBe(true);
  });
});

describe('createToolLoopGuard — identical-noprogress trigger', () => {
  // A successful read-only call, with explicit result content.
  function okWith(
    guard: ReturnType<typeof createToolLoopGuard>,
    id: string,
    input: unknown,
    content: string,
  ) {
    guard.observeToolUse(id, 'bash', input);
    return guard.observeToolResult(id, false, content);
  }

  // The motivating incident: grep exits 1 on no-matches, the CLI reports the
  // call as a completed SUCCESS with empty output, the model reads "command
  // failed" and re-runs it verbatim — forever. No error ever reaches the
  // failure triggers.
  const grepCmd = {
    command:
      "cd /workspace/projects/p1 && grep -n 'font-weight' index.html | grep -v 'font-weight: 400' | grep -v 'font-weight: 500'",
  };

  it('halts a byte-identical successful read-only repeat at the hard ceiling', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    const actions: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const v = okWith(guard, `g-${i}`, grepCmd, '');
      if (v) actions.push(v.action);
    }
    expect(actions).toContain('warn');
    expect(actions).toContain('halt');
    expect(guard.halted).toBe(true);
  });

  it('reports the identical-noprogress reason with the repeat count', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    let verdict = null;
    for (let i = 0; i < 4 && !verdict; i += 1) {
      verdict = okWith(guard, `g-${i}`, grepCmd, '');
    }
    expect(verdict).toMatchObject({
      type: 'tool_loop',
      reason: 'identical-noprogress',
      action: 'warn',
      toolName: 'bash',
      count: 4,
    });
  });

  it('warn mode warns but never halts', () => {
    const guard = createToolLoopGuard({ mode: 'warn' });
    const verdicts: Array<ReturnType<typeof okWith>> = [];
    for (let i = 0; i < 20; i += 1) verdicts.push(okWith(guard, `g-${i}`, grepCmd, ''));
    const seen = verdicts.filter(Boolean);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: 'warn', reason: 'identical-noprogress' });
    expect(guard.halted).toBe(false);
  });

  it('a changing result resets the streak (legitimate polling makes progress)', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    for (let i = 0; i < 20; i += 1) {
      expect(okWith(guard, `poll-${i}`, { command: 'cat status.txt' }, `state-${i}`)).toBeNull();
    }
    expect(guard.warned).toBe(false);
  });

  it('a different call in between resets the streak', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    for (let i = 0; i < 20; i += 1) {
      expect(okWith(guard, `a-${i}`, grepCmd, '')).toBeNull();
      expect(okWith(guard, `b-${i}`, { command: 'cat index.html' }, '<html>')).toBeNull();
    }
    expect(guard.warned).toBe(false);
  });

  it('a successful mutating call clears the streak', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    for (let i = 0; i < 3; i += 1) expect(okWith(guard, `g-${i}`, grepCmd, '')).toBeNull();
    expect(ok(guard, 'fix', 'Edit', { file_path: '/index.html', old_string: 'x' })).toBeNull();
    for (let i = 0; i < 3; i += 1) expect(okWith(guard, `h-${i}`, grepCmd, '')).toBeNull();
    expect(guard.warned).toBe(false);
  });

  it('errored repeats reset the streak: a recovery success is never counted as a loop', () => {
    // Silent checks (grep -q, test -f) produce identical (empty) output whether
    // failing or finally passing. 7 identical errors followed by the recovery
    // success must NOT trip identical-noprogress — the errors belong to the
    // repeated-failure trigger and reset this streak.
    const guard = createToolLoopGuard({ mode: 'halt' });
    const silent = { command: 'grep -q needle haystack.txt' };
    for (let i = 0; i < 7; i += 1) {
      guard.observeToolUse(`e-${i}`, 'bash', silent);
      guard.observeToolResult(`e-${i}`, true, '');
    }
    const recovery = okWith(guard, 'recovered', silent, '');
    expect(recovery).toBeNull();
    expect(guard.halted).toBe(false);
  });

  it('a sleep-prefixed wait poll is progress and never enters the streak', () => {
    const poll = 'sleep 30 && tail -20 build.log';
    expect(isReadOnlyShellCommand(poll)).toBe(false);
    expect(isProgressSuccess('bash', computeToolSignature('bash', { command: poll }))).toBe(true);
    const guard = createToolLoopGuard({ mode: 'halt' });
    for (let i = 0; i < 20; i += 1) {
      expect(okWith(guard, `p-${i}`, { command: poll }, 'compiling...')).toBeNull();
    }
    expect(guard.warned).toBe(false);
  });

  it('successes with no matching tool_use never enter the streak', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    for (let i = 0; i < 20; i += 1) {
      expect(guard.observeToolResult(`orphan-${i}`, false, '')).toBeNull();
    }
    expect(guard.warned).toBe(false);
  });

  it('warn latches are per-trigger: an identical warn does not consume the failure warn', () => {
    const guard = createToolLoopGuard({ mode: 'warn' });
    const verdicts: Array<ReturnType<typeof okWith>> = [];
    for (let i = 0; i < 4; i += 1) verdicts.push(okWith(guard, `g-${i}`, grepCmd, ''));
    const failInput = { command: 'python3 verify.py' };
    for (let i = 0; i < 4; i += 1) verdicts.push(fail(guard, `f-${i}`, 'Bash', failInput));
    const seen = verdicts.filter(Boolean);
    expect(seen.map((v) => v && v.reason)).toEqual(['identical-noprogress', 'repeated-failure']);
  });

  it('identical successful MUTATING repeats never trip (each one is progress)', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    for (let i = 0; i < 20; i += 1) {
      expect(okWith(guard, `m-${i}`, { command: 'pnpm install' }, 'done')).toBeNull();
    }
    expect(guard.warned).toBe(false);
  });

  it('classifies a cd-prefixed grep pipeline as read-only (cd must not count as progress)', () => {
    expect(isReadOnlyShellCommand(grepCmd.command)).toBe(true);
    expect(isProgressSuccess('bash', computeToolSignature('bash', grepCmd))).toBe(false);
  });

  it('unwraps wrapper prefixes instead of classifying the wrapper binary', () => {
    // Inspection stays inspection under a wrapper…
    expect(isReadOnlyShellCommand('timeout 5 grep x file.txt')).toBe(true);
    expect(isReadOnlyShellCommand('timeout -k 5 10 grep x file.txt')).toBe(true);
    expect(isReadOnlyShellCommand('nice -n 10 grep x file.txt')).toBe(true);
    expect(isReadOnlyShellCommand('time cat file.txt')).toBe(true);
    expect(isReadOnlyShellCommand('timeout 5 env CI=1 grep x file.txt')).toBe(true);
    // …and mutation stays mutation — blanket-whitelisting the wrapper would
    // wrongly make these non-progress.
    expect(isReadOnlyShellCommand('timeout 30 pnpm install')).toBe(false);
    expect(isReadOnlyShellCommand('nice -n 10 sed -i s/a/b/ file.txt')).toBe(false);
    expect(isReadOnlyShellCommand('nohup node build.js')).toBe(false);
  });
});

describe('resolveToolLoopMode', () => {
  it('defaults to warn', () => {
    expect(resolveToolLoopMode({})).toBe('warn');
  });
  it('reads off/warn/halt case-insensitively', () => {
    expect(resolveToolLoopMode({ OD_TOOL_LOOP_GUARD: 'OFF' })).toBe('off');
    expect(resolveToolLoopMode({ OD_TOOL_LOOP_GUARD: ' warn ' })).toBe('warn');
    expect(resolveToolLoopMode({ OD_TOOL_LOOP_GUARD: 'HALT' })).toBe('halt');
  });
  it('falls back to warn on an unrecognized value', () => {
    expect(resolveToolLoopMode({ OD_TOOL_LOOP_GUARD: 'disable' })).toBe('warn');
  });
});

describe('maskedOdCliFailure', () => {
  const envelope = '{"error":{"code":"daemon-not-running","message":"HTTP 501: renderer unavailable","data":{}}}';

  it('detects an od failure envelope in a shell tool result tail', () => {
    expect(maskedOdCliFailure('bash', `some output\n${envelope}\n`)).toBe(true);
    expect(maskedOdCliFailure('Bash', envelope)).toBe(true);
  });

  it('ignores the same envelope in non-shell tool results (Read of a source file)', () => {
    expect(maskedOdCliFailure('read', `file contents\n${envelope}`)).toBe(false);
    expect(maskedOdCliFailure('Edit', envelope)).toBe(false);
  });

  it('ignores clean shell output and non-envelope JSON', () => {
    expect(maskedOdCliFailure('bash', '{"file":{"name":"a.png"}}')).toBe(false);
    expect(maskedOdCliFailure('bash', 'all good\nexit 0')).toBe(false);
    expect(maskedOdCliFailure('bash', '')).toBe(false);
  });

  it('ignores an envelope buried above the tail window', () => {
    const tail = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n');
    expect(maskedOdCliFailure('bash', `${envelope}\n${tail}`)).toBe(false);
  });

  it('counts masked failures toward the repeated-failure trigger', () => {
    // `od export … 2>&1 | cat` 洗白退出码的真实事故形态:tool_result 标成功、
    // 信封在输出尾部。守卫必须照常计数并在阈值处 WARN。
    const guard = createToolLoopGuard({ mode: 'warn', warnRepeat: 3 });
    const command = 'env OD_API_TOKEN="$OD_API_TOKEN" "$OD_NODE_BIN" "$OD_BIN" export index.html --format pptx 2>&1 | cat';
    let verdict = null;
    for (let i = 0; i < 3; i += 1) {
      guard.observeToolUse(`u${i}`, 'bash', { command });
      verdict = guard.observeToolResult(`u${i}`, false, `probing...\n${envelope}`);
    }
    expect(verdict).not.toBeNull();
    expect(verdict?.reason).toBe('repeated-failure');
    expect(verdict?.action).toBe('warn');
  });

  it('still treats genuinely clean successes as progress', () => {
    const guard = createToolLoopGuard({ mode: 'warn', warnRepeat: 3 });
    const command = '"$OD_NODE_BIN" "$OD_BIN" export a.html --format pptx 2>&1 | cat';
    guard.observeToolUse('u1', 'bash', { command });
    expect(guard.observeToolResult('u1', false, envelope)).toBeNull();
    guard.observeToolUse('u2', 'bash', { command });
    expect(guard.observeToolResult('u2', false, envelope)).toBeNull();
    // 同一动作真的成功了 → 计数清零,再失败两次也不触发
    guard.observeToolUse('u3', 'bash', { command });
    expect(guard.observeToolResult('u3', false, '{"ok":true,"out":"index.pptx"}')).toBeNull();
    guard.observeToolUse('u4', 'bash', { command });
    expect(guard.observeToolResult('u4', false, envelope)).toBeNull();
    guard.observeToolUse('u5', 'bash', { command });
    expect(guard.observeToolResult('u5', false, envelope)).toBeNull();
  });
});

// Trigger 4 — tool calls the model wrote as prose instead of invoking. The
// motivating incident: a Kimi model whose provider config never declared the
// tool_call capability emitted `[tool_call] bash {...}` as assistant text over
// and over. Nothing executed, no tool_result ever came back, and triggers 1–3
// (which count tool events) saw literally nothing while the run hung until the
// 10-minute inactivity watchdog killed it.
describe('tool-loop guard — text tool calls (trigger 4)', () => {
  const KIMI = '[tool_call] bash\n{"command": "find /workspace -name \\"*.so*\\" | head -30"}';

  it('halts once the model has written enough tool calls as text', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    expect(guard.observeAssistantText(KIMI)).toBeNull(); // 1st — below warn
    const warn = guard.observeAssistantText(KIMI);
    expect(warn).toMatchObject({ reason: 'text-tool-call', action: 'warn', count: 2, toolName: 'bash' });
    const halt = guard.observeAssistantText(KIMI);
    expect(halt).toMatchObject({ reason: 'text-tool-call', action: 'halt', count: 3 });
    expect(guard.halted).toBe(true);
  });

  it('never halts in warn mode, and warns only once', () => {
    const guard = createToolLoopGuard({ mode: 'warn' });
    expect(guard.observeAssistantText(KIMI)).toBeNull();
    expect(guard.observeAssistantText(KIMI)).toMatchObject({ action: 'warn' });
    expect(guard.observeAssistantText(KIMI)).toBeNull();
    expect(guard.observeAssistantText(KIMI)).toBeNull();
    expect(guard.halted).toBe(false);
    expect(guard.warned).toBe(true);
  });

  it('is disarmed by a real tool call — prose markers are then cosmetic', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    guard.observeToolUse('t1', 'Bash', { command: 'ls' });
    guard.observeToolResult('t1', false, 'a.txt');
    // An agent that WRITES about tool calls (docs, a code block) must not be
    // halted for it once native tool calling has demonstrably worked.
    for (let i = 0; i < 10; i += 1) {
      expect(guard.observeAssistantText(KIMI)).toBeNull();
    }
    expect(guard.halted).toBe(false);
  });

  it('counts a marker split across stream chunks exactly once', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    // Split mid-marker: neither half matches alone; the rejoin must match, and
    // the retained tail must not let the same marker count twice.
    guard.observeAssistantText('[tool_');
    expect(guard.observeAssistantText('call] bash\n{"command":"ls"}')).toBeNull(); // 1st
    guard.observeAssistantText('[tool_');
    const warn = guard.observeAssistantText('call] bash\n{"command":"ls"}'); // 2nd
    expect(warn).toMatchObject({ action: 'warn', count: 2 });
  });

  it('counts every marker in a single chunk', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    const verdict = guard.observeAssistantText(`${KIMI}\n${KIMI}\n${KIMI}`);
    expect(verdict).toMatchObject({ reason: 'text-tool-call', action: 'halt', count: 3 });
  });

  it('matches the XML tool-call family too', () => {
    const guard = createToolLoopGuard({ mode: 'halt', warnTextToolCall: 1 });
    expect(guard.observeAssistantText('<tool_call>bash</tool_call>')).toMatchObject({
      reason: 'text-tool-call',
      action: 'warn',
    });
  });

  it('ignores ordinary prose and is inert when off', () => {
    const guard = createToolLoopGuard({ mode: 'halt' });
    expect(guard.observeAssistantText('I will now call the bash tool to list files.')).toBeNull();
    expect(guard.observeAssistantText('Here is a {"command": "ls"} payload.')).toBeNull();
    expect(guard.halted).toBe(false);

    const off = createToolLoopGuard({ mode: 'off' });
    for (let i = 0; i < 5; i += 1) expect(off.observeAssistantText(KIMI)).toBeNull();
    expect(off.halted).toBe(false);
  });
});
