function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runSandboxResearch(args: string[]): Promise<void> {
  const usage = 'Usage: od research search --query <text> [--max-sources 5] [--providers pinterest]';
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return;
  }
  if (args[0] !== 'search') {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const query = valueAfter(args, '--query')?.trim();
  if (!query) throw new Error('--query required');
  const daemonUrl = (valueAfter(args, '--daemon-url') ?? process.env.OD_DAEMON_URL ?? '').replace(/\/$/, '');
  const token = process.env.OD_TOOL_TOKEN;
  if (!daemonUrl) throw new Error('OD_DAEMON_URL or --daemon-url is required');
  if (!token) throw new Error('OD_TOOL_TOKEN is required for sandbox research');
  const providers = (valueAfter(args, '--providers') ?? 'pinterest')
    .split(',').map((provider) => provider.trim()).filter(Boolean);
  const rawMax = valueAfter(args, '--max-sources');
  const maxSources = rawMax == null ? undefined : Number(rawMax);
  const response = await fetch(`${daemonUrl}/api/tools/research/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, providers, ...(Number.isFinite(maxSources) ? { maxSources } : {}) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`daemon ${response.status}: ${text}`);
  process.stdout.write(`${text}\n`);
}
