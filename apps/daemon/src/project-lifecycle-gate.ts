export class ProjectDeletingError extends Error {
  readonly code = 'PROJECT_DELETING';

  constructor(readonly projectId: string) {
    super(`project ${projectId} is being deleted`);
    this.name = 'ProjectDeletingError';
  }
}

export class ProjectDeletedError extends Error {
  readonly code = 'PROJECT_DELETED';

  constructor(readonly projectId: string) {
    super(`project ${projectId} has been deleted`);
    this.name = 'ProjectDeletedError';
  }
}

type LifecycleState = {
  status: 'active' | 'deleting' | 'deleted';
  activeWrites: number;
  owner: symbol | undefined;
  drained: Set<() => void>;
};

const states = new Map<string, LifecycleState>();

function stateFor(projectId: string): LifecycleState {
  let state = states.get(projectId);
  if (!state) {
    state = { status: 'active', activeWrites: 0, owner: undefined, drained: new Set() };
    states.set(projectId, state);
  }
  return state;
}

function inactiveError(projectId: string, state: LifecycleState): ProjectDeletingError | ProjectDeletedError {
  return state.status === 'deleted'
    ? new ProjectDeletedError(projectId)
    : new ProjectDeletingError(projectId);
}

export function assertProjectActive(projectId: string): void {
  const state = stateFor(projectId);
  if (state.status !== 'active') throw inactiveError(projectId, state);
}

/** Clears a deletion tombstone after the SQLite project row was successfully recreated. */
export function markProjectActive(projectId: string): void {
  const state = stateFor(projectId);
  if (state.status === 'deleting') throw new ProjectDeletingError(projectId);
  state.status = 'active';
  state.owner = undefined;
}

/**
 * Registers a project-scoped operation without yielding between the lifecycle
 * check and registration. Deletion therefore either rejects the operation or
 * waits for its complete async critical section.
 */
export async function runProjectActiveOperation<T>(
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  const state = stateFor(projectId);
  if (state.status !== 'active') throw inactiveError(projectId, state);
  state.activeWrites += 1;
  try {
    return await work();
  } finally {
    state.activeWrites -= 1;
    if (state.activeWrites === 0) {
      const waiters = [...state.drained];
      state.drained.clear();
      for (const resolve of waiters) resolve();
    }
  }
}

export async function runProjectMemoryWrite<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  return runProjectActiveOperation(projectId, work);
}

export interface ProjectDeletionHandle {
  readonly projectIds: readonly string[];
  rollback(): void;
  commit(): void;
}

/**
 * Synchronously marks the entire sorted id set before its first await, then
 * waits for already-registered writes to drain. The all-or-nothing preflight
 * also makes overlapping/repeated deletion attempts fail predictably without
 * partially gating their id set.
 */
export async function beginProjectDeletion(projectIds: readonly string[]): Promise<ProjectDeletionHandle> {
  const ids = [...new Set(projectIds)].sort();
  const owner = Symbol('project-deletion');

  for (const id of ids) {
    const state = stateFor(id);
    if (state.status !== 'active') throw inactiveError(id, state);
  }
  for (const id of ids) {
    const state = stateFor(id);
    state.status = 'deleting';
    state.owner = owner;
  }

  await Promise.all(ids.map((id) => {
    const state = stateFor(id);
    if (state.activeWrites === 0) return Promise.resolve();
    return new Promise<void>((resolve) => state.drained.add(resolve));
  }));

  let settled = false;
  return {
    projectIds: ids,
    rollback() {
      if (settled) return;
      settled = true;
      for (const id of ids) {
        const state = stateFor(id);
        if (state.status === 'deleting' && state.owner === owner) {
          state.status = 'active';
          state.owner = undefined;
        }
      }
    },
    commit() {
      if (settled) return;
      settled = true;
      for (const id of ids) {
        const state = stateFor(id);
        if (state.status === 'deleting' && state.owner === owner) {
          state.status = 'deleted';
          state.owner = undefined;
        }
      }
    },
  };
}

export function isProjectLifecycleError(error: unknown): error is ProjectDeletingError | ProjectDeletedError {
  return error instanceof ProjectDeletingError || error instanceof ProjectDeletedError;
}

/** Test isolation only. */
export function __resetProjectLifecycleGateForTests(): void {
  states.clear();
}
