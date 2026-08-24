import { MemoryInputError } from './memory-errors.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export function validateMemoryProjectId(value: unknown): string {
  if (
    typeof value !== 'string'
    || Array.from(value).length < 1
    || Array.from(value).length > 128
    || CONTROL_CHARACTER.test(value)
  ) {
    throw new MemoryInputError('projectId must be 1-128 characters with no control characters');
  }
  return value;
}

/**
 * Opaque run scope. Callers must construct it from a project record that has
 * already been loaded by the daemon's project authority path.
 */
export class TrustedMemoryScope {
  private constructor(readonly projectId: string) {
    Object.freeze(this);
  }

  static fromLoadedProject(project: { id?: unknown } | null | undefined): TrustedMemoryScope | undefined {
    if (!project) return undefined;
    return new TrustedMemoryScope(validateMemoryProjectId(project.id));
  }
}
