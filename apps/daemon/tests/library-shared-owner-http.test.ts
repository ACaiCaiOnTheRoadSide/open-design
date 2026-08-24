import { access, mkdtemp, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrincipalAuthMiddleware } from '../src/principal-auth.js';
import { getRequestContext, type VerifiedPrincipal } from '../src/request-context.js';
import { deleteLibraryAsset, getLibraryAsset, migrateLibrary } from '../src/library-store.js';
import { registerLibraryRoutes } from '../src/routes/library.js';
import type {
  ResourceOwnerRegistry,
  ResourceOwnershipInput,
  SaaSResourceKind,
} from '../src/storage/resource-owner-registry.js';

class MemoryOwners implements ResourceOwnerRegistry {
  private readonly active = new Set<string>();
  private beforeNextClaim: ((input: ResourceOwnershipInput) => void | Promise<void>) | undefined;
  simulateDeleteBeforeNextClaim(work: (input: ResourceOwnershipInput) => void | Promise<void>): void {
    this.beforeNextClaim = work;
  }
  private key(kind: SaaSResourceKind, tenant: string, id: string): string {
    return `${kind}\0${tenant}\0${id}`;
  }
  async registerUser(input: ResourceOwnershipInput): Promise<void> {
    const principal = getRequestContext();
    if (!principal) throw new Error('missing principal');
    const beforeClaim = this.beforeNextClaim;
    this.beforeNextClaim = undefined;
    await beforeClaim?.(input);
    this.active.add(this.key(input.kind, principal.tenantId, input.id));
  }
  async registerBackend(input: ResourceOwnershipInput): Promise<void> {
    this.active.add(this.key(input.kind, '__backend__', input.id));
  }
  async isVisible(kind: SaaSResourceKind, id: string): Promise<boolean> {
    const tenant = getRequestContext()?.tenantId ?? '';
    return this.active.has(this.key(kind, tenant, id)) || this.active.has(this.key(kind, '__backend__', id));
  }
  async filterVisibleIds(kind: SaaSResourceKind, ids: readonly string[]): Promise<Set<string>> {
    const visible = new Set<string>();
    for (const id of ids) if (await this.isVisible(kind, id)) visible.add(id);
    return visible;
  }
  async softDelete(kind: SaaSResourceKind, id: string): Promise<boolean> {
    return (await this.release(kind, id)).deleted;
  }
  async hasOtherActiveOwners(kind: SaaSResourceKind, id: string): Promise<boolean> {
    const tenant = getRequestContext()?.tenantId ?? '';
    return [...this.active].some((key) => key.startsWith(`${kind}\0`) && key.endsWith(`\0${id}`)
      && key !== this.key(kind, tenant, id));
  }
  async release(
    kind: SaaSResourceKind,
    id: string,
    _principal?: Readonly<VerifiedPrincipal>,
    onLastOwner?: () => void | Promise<void>,
  ): Promise<{ deleted: boolean; hasActiveOwners: boolean }> {
    const tenant = getRequestContext()?.tenantId ?? '';
    const deleted = this.active.delete(this.key(kind, tenant, id));
    const hasActiveOwners = deleted && await this.hasOtherActiveOwners(kind, id);
    if (deleted && !hasActiveOwners) await onLastOwner?.();
    return { deleted, hasActiveOwners };
  }
  async isBackendManaged(kind: SaaSResourceKind, id: string): Promise<boolean> {
    return this.active.has(this.key(kind, '__backend__', id));
  }
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

function tenantRequest(base: string, tenant: string, method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method,
    headers: {
      authorization: 'Bearer test-secret',
      'x-tenant-id': tenant,
      'x-od-user-id': `${tenant}-user`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('library shared asset HTTP deletion', () => {
  it('keeps the shared SQLite row and file until the final tenant owner deletes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-library-owner-'));
    const libraryDir = path.join(root, 'library');
    const db = new Database(path.join(root, 'daemon.sqlite'));
    migrateLibrary(db);
    const owners = new MemoryOwners();

    const app = express();
    app.use(express.json());
    app.use(createPrincipalAuthMiddleware({ enabled: true, source: 'trusted-proxy', apiToken: 'test-secret' }));
    registerLibraryRoutes(app, {
      db,
      resourceOwnerRegistry: owners,
      paths: { LIBRARY_DIR: libraryDir, PROJECTS_DIR: path.join(root, 'projects'), USER_DESIGN_SYSTEMS_DIR: path.join(root, 'systems') },
      http: {
        sendApiError: (res: ExpressResponse, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }),
        createSseResponse: () => ({ send: () => undefined, cleanup: () => undefined }),
        requireLocalDaemonRequest: (_req: Request, _res: ExpressResponse, next: NextFunction) => next(),
        isLocalSameOrigin: () => true,
        resolvedPortRef: { current: 0 },
      },
      projectStore: {
        getProject: () => null, insertProject: () => undefined, ensureWorkspaceProject: () => undefined,
        getWorkspaceProject: () => null, getWorkspaceProjectByProjectId: () => null,
      },
      projectFiles: { writeProjectFile: async () => undefined },
      conversations: { insertConversation: () => undefined },
      auth: { authorizeToolRequest: () => null },
    } as never);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listen address');
    const base = `http://127.0.0.1:${address.port}`;
    cleanup = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      await rm(root, { recursive: true, force: true });
    };

    const payload = { text: 'same-content', mime: 'text/plain', filename: 'shared.txt' };
    const ingestA = await tenantRequest(base, 'tenant-a', 'POST', '/api/library/ingest', payload);
    const ingestB = await tenantRequest(base, 'tenant-b', 'POST', '/api/library/ingest', payload);
    expect(ingestA.status).toBe(200);
    expect(ingestB.status).toBe(200);
    const idA = ((await ingestA.json()) as { asset: { id: string } }).asset.id;
    const idB = ((await ingestB.json()) as { asset: { id: string } }).asset.id;
    expect(idB).toBe(idA);
    const asset = getLibraryAsset(db, idA)!;

    expect((await tenantRequest(base, 'tenant-a', 'DELETE', `/api/library/assets/${asset.id}`)).status).toBe(200);
    expect(getLibraryAsset(db, asset.id)).not.toBeNull();
    await expect(access(asset.filePath!)).resolves.toBeUndefined();
    expect((await tenantRequest(base, 'tenant-a', 'GET', `/api/library/assets/${asset.id}`)).status).toBe(404);
    expect((await tenantRequest(base, 'tenant-b', 'GET', `/api/library/assets/${asset.id}`)).status).toBe(200);

    expect((await tenantRequest(base, 'tenant-b', 'DELETE', `/api/library/assets/${asset.id}`)).status).toBe(200);
    expect(getLibraryAsset(db, asset.id)).toBeNull();
    await expect(access(asset.filePath!)).rejects.toThrow();

    // Model the final-owner deletion winning after a new ingest created its
    // SQLite row but before that request acquired the PostgreSQL owner lock.
    // The HTTP route must detect the vanished row, discard the stale claim and
    // retry rather than returning an asset whose bytes were just removed.
    owners.simulateDeleteBeforeNextClaim(async (input) => {
      const raced = getLibraryAsset(db, input.id)!;
      deleteLibraryAsset(db, input.id);
      await unlink(raced.filePath!).catch(() => undefined);
    });
    const racedIngest = await tenantRequest(base, 'tenant-c', 'POST', '/api/library/ingest', payload);
    expect(racedIngest.status).toBe(200);
    const racedId = ((await racedIngest.json()) as { asset: { id: string } }).asset.id;
    const recovered = getLibraryAsset(db, racedId);
    expect(recovered).not.toBeNull();
    await expect(access(recovered!.filePath!)).resolves.toBeUndefined();
    expect((await tenantRequest(base, 'tenant-c', 'GET', `/api/library/assets/${racedId}`)).status).toBe(200);
  });
});
