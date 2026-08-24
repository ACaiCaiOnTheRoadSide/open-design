/**
 * URL router round-trip tests (issue #1505).
 *
 * Pins the deep-link shape for the project route:
 *
 *   /                                                 home
 *   /projects/:id                                     project root
 *   /projects/:id/files/:path                         file view
 *   /projects/:id/conversations/:cid                  specific conversation
 *   /projects/:id/conversations/:cid/files/:path      conversation + file
 *
 * The conversation segment was added to unblock the Routines history
 * row: clicking "Open project" on a parallel run's row needs to land
 * the user on that run's own conversation, not on whatever the
 * project happens to default to.
 */

import { describe, expect, it } from 'vitest';

import { buildPath, isTrustedEmbedParentOrigin, parseRoute, type Route } from '../src/router';

describe('embedded route notification origin policy', () => {
  it('allows same-origin and explicit parents but rejects arbitrary embedders', () => {
    const configured = new Set(['https://saas.example.com']);
    expect(isTrustedEmbedParentOrigin('https://od.example.com', 'https://od.example.com', configured)).toBe(true);
    expect(isTrustedEmbedParentOrigin('https://saas.example.com', 'https://od.example.com', configured)).toBe(true);
    expect(isTrustedEmbedParentOrigin('https://evil.example.com', 'https://od.example.com', configured)).toBe(false);
  });
});

function roundTrip(route: Route): Route {
  return parseRoute(buildPath(route));
}

describe('parseRoute / buildPath (issue #1505)', () => {
  it('parses the home route', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('')).toEqual({ kind: 'home', view: 'home' });
  });

  it('round-trips a bare project route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1');
  });

  it('round-trips a project + file route (no conversation)', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'src/index.tsx',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/files/src/index.tsx');
  });

  it('round-trips a project + conversation route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/conversations/conv-abc');
  });

  it('round-trips a project + conversation + file route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: 'index.html',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/conversations/conv-abc/files/index.html');
  });

  it('percent-encodes ids and file names with reserved characters', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p/1 with space',
      conversationId: 'conv/abc with space',
      fileName: 'dir/file name.tsx',
    };
    const built = buildPath(route);
    expect(built).toContain('p%2F1%20with%20space');
    expect(built).toContain('conv%2Fabc%20with%20space');
    // File path components are percent-encoded individually so the
    // slash between segments survives.
    expect(built.endsWith('/dir/file%20name.tsx')).toBe(true);
    expect(roundTrip(route)).toEqual(route);
  });

  it('parses a legacy project + file URL with no conversation segment', () => {
    expect(parseRoute('/projects/p-1/files/README.md')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'README.md',
    });
  });

  it('parses a project + conversation URL with no file segment', () => {
    expect(parseRoute('/projects/p-1/conversations/c-2')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'c-2',
      fileName: null,
    });
  });

  it('falls back to home when the URL is unrecognized', () => {
    expect(parseRoute('/something/else')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('/projects')).toEqual({ kind: 'home', view: 'projects' });
  });

  it('parses the collab demo route with and without a project id', () => {
    expect(parseRoute('/collab-demo')).toEqual({ kind: 'collab-demo', projectId: null });
    expect(parseRoute('/collab-demo/p%201')).toEqual({ kind: 'collab-demo', projectId: 'p 1' });
  });

  it('round-trips the collab demo route', () => {
    expect(roundTrip({ kind: 'collab-demo', projectId: null })).toEqual({ kind: 'collab-demo', projectId: null });
    expect(roundTrip({ kind: 'collab-demo', projectId: 'p-9' })).toEqual({ kind: 'collab-demo', projectId: 'p-9' });
  });
});
