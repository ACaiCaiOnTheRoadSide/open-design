export class MemoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryInputError';
  }
}

export class MemoryNotFoundError extends Error {
  constructor(message = 'memory not found') {
    super(message);
    this.name = 'MemoryNotFoundError';
  }
}

/** A trusted-proxy mutation raced with a move into project scope. */
export class ProjectMemoryScopeUnverifiedError extends Error {
  constructor(message = 'project memory scope could not be verified atomically') {
    super(message);
    this.name = 'ProjectMemoryScopeUnverifiedError';
  }
}
