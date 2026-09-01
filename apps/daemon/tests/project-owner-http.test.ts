import express, { type NextFunction, type Request, type Response } from 'express';
import type http from 'node:http';
import { AsyncResource } from 'node:async_hooks';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthorizeProjectRequest } from '../src/collab/project-request-authority.js';
import { createPrincipalAuthMiddleware } from '../src/principal-auth.js';
import { getRequestContext, requireRequestContext } from '../src/request-context.js';
import { registerProjectUploadRoutes } from '../src/routes/project/index.js';

describe('hosted unbound project HTTP tenancy', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()));

  it('lets A use its project while B cannot list or guess any data-plane route', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createPrincipalAuthMiddleware({
      enabled: true, source: 'trusted-proxy', apiToken: 'test-token',
    }));
    const owners = new Map<string, { tenantId: string; userId: string } | null>();
    const authorize = createAuthorizeProjectRequest({
      db: owners,
      getWorkspaceProject: () => null,
      getWorkspaceProjectByProjectId: () => null,
      enforceUnboundProjectOwner: true,
      getProjectFactOwner: (db, id) => (db as typeof owners).get(id),
      sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }),
    });
    app.post('/api/projects', (_req, res) => {
      owners.set('owned-a', { ...requireRequestContext() });
      res.status(201).json({ id: 'owned-a' });
    });
    app.get('/api/projects', (_req, res) => {
      const principal = requireRequestContext();
      res.json({ projects: [...owners].filter(([, owner]) => owner?.tenantId === principal.tenantId && owner.userId === principal.userId).map(([id]) => ({ id })) });
    });
    const reads = ['/api/projects/:id', '/api/projects/:id/files', '/api/projects/:id/conversations', '/api/projects/:id/preview/index.html', '/api/projects/:id/raw/index.html'];
    for (const route of reads) app.get(route, async (req, res) => {
      const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!projectId) return res.status(400).end();
      if (!await authorize(req, res, projectId, { mode: 'read' })) return;
      res.json({ ok: true });
    });
    for (const route of ['/api/projects/:id', '/api/projects/:id/files/x', '/api/projects/:id/run']) {
      app.post(route, async (req, res) => {
        const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!projectId) return res.status(400).end();
        if (!await authorize(req, res, projectId, { mode: 'write', capability: 'writeFiles' })) return;
        res.json({ ok: true });
      });
    }
    owners.set('legacy', null);
    const listeningServer = await new Promise<http.Server>((resolve, reject) => {
      const started = app.listen(0, '127.0.0.1', (error?: Error) => {
        if (error) reject(error);
        else resolve(started);
      });
    });
    server = listeningServer;
    const address = listeningServer.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const headers = (tenantId: string, userId: string) => ({
      authorization: 'Bearer test-token', 'x-tenant-id': tenantId, 'x-od-user-id': userId,
    });
    expect((await fetch(`${base}/api/projects`, { method: 'POST', headers: headers('tenant-a', 'user-a') })).status).toBe(201);
    expect(await (await fetch(`${base}/api/projects`, { headers: headers('tenant-b', 'user-b') })).json()).toEqual({ projects: [] });
    for (const path of reads.map((route) => route.replace(':id', 'owned-a'))) {
      expect((await fetch(`${base}${path}`, { headers: headers('tenant-b', 'user-b') })).status).toBe(404);
      expect((await fetch(`${base}${path}`, { headers: headers('tenant-a', 'user-a') })).status).toBe(200);
    }
    for (const path of ['/api/projects/owned-a', '/api/projects/owned-a/files/x', '/api/projects/owned-a/run']) {
      expect((await fetch(`${base}${path}`, { method: 'POST', headers: headers('tenant-b', 'user-b') })).status).toBe(403);
      expect((await fetch(`${base}${path}`, { method: 'POST', headers: headers('tenant-a', 'user-a') })).status).toBe(200);
    }
    expect((await fetch(`${base}/api/projects/legacy`, { headers: headers('tenant-a', 'user-a') })).status).toBe(404);
  });

  it('restores the verified principal after multipart parsing leaves request ALS', async () => {
    const app = express();
    app.use('/api', createPrincipalAuthMiddleware({
      enabled: true, source: 'trusted-proxy', apiToken: 'test-token',
    }));
    const detachedUploadResource = new AsyncResource('detached-project-upload');
    registerProjectUploadRoutes(app, {
      db: {},
      http: {
        sendApiError: (res: Response, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
      },
      uploads: {
        handleProjectUpload: (req: Request, _res: Response, next: NextFunction) => {
          detachedUploadResource.runInAsyncScope(() => {
            req.files = [];
            next();
          });
        },
      },
      node: { fs },
      paths: { PROJECTS_DIR: '/tmp' },
      projectStore: {
        getProject: () => ({ id: 'owned-a', metadata: {} }),
        getWorkspaceProject: () => null,
        getWorkspaceProjectByProjectId: () => null,
      },
      projectFiles: { readProjectFile: async () => { throw new Error('not used'); } },
      authorizeProjectRequest: async (_req: Request, res: Response) => {
        if (getRequestContext()) return true;
        res.status(403).json({ error: { code: 'PROJECT_PERMISSION_DENIED' } });
        return false;
      },
    } as never);

    const listeningServer = await new Promise<http.Server>((resolve, reject) => {
      const started = app.listen(0, '127.0.0.1', (error?: Error) => {
        if (error) reject(error);
        else resolve(started);
      });
    });
    server = listeningServer;
    const address = listeningServer.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const response = await fetch(`${base}/api/projects/owned-a/upload`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'x-tenant-id': 'tenant-a',
        'x-od-user-id': 'user-a',
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ files: [] });
    detachedUploadResource.emitDestroy();
  });
});
