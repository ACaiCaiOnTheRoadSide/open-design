import { amrAgentDef } from './defs/amr.js';
import { claudeAgentDef } from './defs/claude.js';
import { codexAgentDef } from './defs/codex.js';
import { devinAgentDef } from './defs/devin.js';
import { opencodeAgentDef } from './defs/opencode.js';
import { byokOpenCodeAgentDef } from './defs/byok-opencode.js';
import { hermesAgentDef } from './defs/hermes.js';
import { traeCliAgentDef } from './defs/trae-cli.js';
import { grokBuildAgentDef } from './defs/grok-build.js';
import { kimiAgentDef } from './defs/kimi.js';
import { cursorAgentDef } from './defs/cursor-agent.js';
import { qwenAgentDef } from './defs/qwen.js';
import { qoderAgentDef } from './defs/qoder.js';
import { copilotAgentDef } from './defs/copilot.js';
import { ampAgentDef } from './defs/amp.js';
import { piAgentDef } from './defs/pi.js';
import { kiroAgentDef } from './defs/kiro.js';
import { kiloAgentDef } from './defs/kilo.js';
import { vibeAgentDef } from './defs/vibe.js';
import { deepseekAgentDef } from './defs/deepseek.js';
import { deepseekHarnessAgentDef } from './defs/deepseek-harness.js';
import { aiderAgentDef } from './defs/aider.js';
import { antigravityAgentDef } from './defs/antigravity.js';
import { codebuddyAgentDef } from './defs/codebuddy.js';
import { reasonixAgentDef } from './defs/reasonix.js';
import { mimoAgentDef } from './defs/mimo.js';
import { atomcodeAgentDef } from './defs/atomcode.js';
import { readLocalAgentProfileDefs as readLocalAgentProfileDefsFromFile } from './local-profiles.js';
import type { RuntimeAgentDef } from './types.js';

const ALL_AGENT_DEFS: RuntimeAgentDef[] = [
  amrAgentDef,
  claudeAgentDef,
  codexAgentDef,
  devinAgentDef,
  opencodeAgentDef,
  byokOpenCodeAgentDef,
  hermesAgentDef,
  traeCliAgentDef,
  grokBuildAgentDef,
  kimiAgentDef,
  cursorAgentDef,
  qwenAgentDef,
  qoderAgentDef,
  copilotAgentDef,
  ampAgentDef,
  piAgentDef,
  kiroAgentDef,
  kiloAgentDef,
  vibeAgentDef,
  deepseekAgentDef,
  deepseekHarnessAgentDef,
  aiderAgentDef,
  antigravityAgentDef,
  reasonixAgentDef,
  codebuddyAgentDef,
  mimoAgentDef,
  atomcodeAgentDef,
];

// Unset/blank preserves local compatibility; a configured list is a strict
// allowlist. Unknown ids produce an empty registry rather than widening access.
const allowedRaw = (process.env.OD_ALLOWED_AGENTS ?? '').trim();
const allowedIds = allowedRaw
  ? new Set(allowedRaw.split(',').map((value) => value.trim()).filter(Boolean))
  : null;
const BASE_AGENT_DEFS = allowedIds
  ? ALL_AGENT_DEFS.filter((definition) => allowedIds.has(definition.id))
  : ALL_AGENT_DEFS;

export function readLocalAgentProfileDefs(
  baseDefs: RuntimeAgentDef[] = BASE_AGENT_DEFS,
): RuntimeAgentDef[] {
  return readLocalAgentProfileDefsFromFile(baseDefs);
}

const discoveredAgentDefs: RuntimeAgentDef[] = [
  ...BASE_AGENT_DEFS,
  ...readLocalAgentProfileDefs(BASE_AGENT_DEFS),
];
export const AGENT_DEFS: RuntimeAgentDef[] = allowedIds
  ? discoveredAgentDefs.filter((definition) => allowedIds.has(definition.id))
  : discoveredAgentDefs;

const ids = new Set();
for (const def of AGENT_DEFS) {
  if (ids.has(def.id)) {
    throw new Error(`Duplicate agent definition id: ${def.id}`);
  }
  ids.add(def.id);
}

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((a) => a.id === id) || null;
}
