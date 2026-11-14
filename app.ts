// The entry's HTTP server: health probe, git smart HTTP, REST v3, GraphQL v4 and MCP.
// Auth: every /api/v3 and /api/graphql and /mcp call needs the bearer token from
// MAKEFUN_SHOP_TOKEN (any non-empty bearer when the variable is unset, for local runs).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleGit } from './gitserver.ts';
import { handleRest, sendJson, sendError, type Ctx } from './rest.ts';
import { runGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendRawJson(res: ServerResponse, status: number, data: unknown): void {
  const text = `${JSON.stringify(data)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, read:org',
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function authed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const expected = store.token;
  if (expected === '') return auth.startsWith('Bearer ') && auth.length > 7;
  return auth === `Bearer ${expected}`;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && path === '/healthz') {
          sendRawJson(res, 200, { ok: true });
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const url = new URL(req.url ?? '/', 'http://entry');
          const handled = await handleGit(req, res, gitMatch[1], gitMatch[2], gitMatch[3] ?? '/', url.searchParams);
          if (handled) return;
          sendRawJson(res, 404, { message: 'Not Found' });
          return;
        }
        // MCP
        if (path === '/mcp') {
          const handled = await handleMcp(req, res);
          if (handled) return;
          sendRawJson(res, 404, { message: 'Not Found' });
          return;
        }
        // GraphQL
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendRawJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authed(req)) {
            sendRawJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendRawJson(res, 400, { message: 'malformed JSON' });
            return;
          }
          const result = runGraphQL(body);
          sendRawJson(res, 200, result);
          return;
        }
        // REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            sendRawJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          let body: unknown = {};
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                const url = new URL(req.url ?? '/', 'http://entry');
                const ctx: Ctx = { req, res, query: url.searchParams, body: null, segments: [] };
                sendError(ctx, 400, 'malformed JSON');
                return;
              }
            }
          }
          const url = new URL(req.url ?? '/', 'http://entry');
          const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
          const ctx: Ctx = { req, res, query: url.searchParams, body, segments };
          const handled = handleRest(ctx);
          if (handled) return;
          sendError(ctx, 404, 'Not Found');
          return;
        }
        sendRawJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendRawJson(res, 500, { message: String((err as Error).message) });
        } catch {
          // response already gone
        }
      }
    })();
  });
}
