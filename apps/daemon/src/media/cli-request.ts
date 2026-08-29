export const MEDIA_GENERATE_STRING_FLAGS = new Set([
  'project',
  'workspace',
  'workspace-member',
  'surface',
  'model',
  'prompt',
  'prompt-file',
  'output',
  'aspect',
  'quality',
  'resolution',
  'length',
  'duration',
  'prompt-influence',
  'voice',
  'audio-kind',
  'composition-dir',
  'image',
  'daemon-url',
  'language',
]);

export const MEDIA_GENERATE_BOOLEAN_FLAGS = new Set(['help', 'h', 'loop']);

export type MediaGenerateFlags = Record<string, string | boolean | undefined>;

/**
 * Build the whitelisted daemon payload shared by the full CLI and the
 * dependency-free sandbox bundle. Keeping this in one place prevents the
 * downloadable CLI from accidentally forwarding arbitrary agent flags.
 */
export function buildMediaGenerateBody(
  flags: MediaGenerateFlags,
  prompt: string | null,
  images: string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    surface: flags.surface,
    model: flags.model,
    prompt,
    output: flags.output,
    aspect: flags.aspect,
    quality: flags.quality,
    resolution: flags.resolution,
    voice: flags.voice,
    audioKind: flags['audio-kind'],
    compositionDir: flags['composition-dir'],
    image: images[0],
    images,
    language: flags.language,
  };
  if (flags.length != null) body.length = Number(flags.length);
  if (flags.duration != null) body.duration = Number(flags.duration);
  if (flags['prompt-influence'] != null) {
    body.promptInfluence = Number(flags['prompt-influence']);
  }
  if (flags.loop === true) body.loop = true;
  return body;
}
