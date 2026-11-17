// The forge's HTTP surface: /healthz, git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3,
// GraphQL at /api/graphql and MCP at /mcp. Every API reply is JSON with an X-GitHub-Request-Id; the
// request id is a counter and no Date header is sent, so nothing served reads the wall clock.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type Reply } from './src/rest.ts';
import { advertisement, receivePack, uploadPack } from './src/smart.ts';
import { ApiError, findRepo } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const SCOPES = 'repo, read:org, workflow';

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `F0RG:${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`;
}

type Auth = 'ok' | 'missing' | 'bad';

function authOf(req: IncomingMessage): Auth {
  const header = req.headers.authorization;
  if (header === undefined || header === '') return 'missing';
  const m = /^(?:bearer|token)\s+(\S+)\s*$/i.exec(header);
  if (m === null) return 'bad';
  return TOKEN === '' || m[1] === TOKEN ? 'ok' : 'bad';
}

function send(res: ServerResponse, status: number, body: string | Buffer | undefined, headers: Record<string, string>): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.length);
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: string | undefined, extra?: Record<string, string>): void {
  const headers: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() };
  if (extra !== undefined) Object.assign(headers, extra);
  send(res, status, status === 204 ? undefined : body, headers);
}

function errorBody(err: ApiError): string {
  return JSON.stringify({ message: err.message, ...(err.extra ?? {}), documentation_url: 'https://docs.github.com/rest' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const buf = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
      if ((req.headers['content-encoding'] ?? '').toLowerCase() === 'gzip') {
        try {
          resolve(gunzipSync(buf));
        } catch (err) {
          reject(err);
        }
      } else resolve(buf);
    });
    req.on('error', reject);
  });
}

function splitPath(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '') continue;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

// ------------------------------------------------------------------ REST

async function serveRest(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: string): Promise<void> {
  const auth = authOf(req);
  if (auth !== 'ok') {
    const body = await readBody(req).catch(() => Buffer.alloc(0));
    void body;
    sendJson(res, 401, JSON.stringify({ message: auth === 'missing' ? 'Requires authentication' : 'Bad credentials', documentation_url: 'https://docs.github.com/rest' }));
    return;
  }
  let parsed: unknown;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, JSON.stringify({ message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' }));
        return;
      }
    }
  }
  const segs = splitPath(path.slice(7));
  let reply: Reply;
  try {
    reply = handleRest(method, segs, new URLSearchParams(query), parsed, req.headers.host ?? 'localhost', path);
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(res, err.status, errorBody(err));
      return;
    }
    process.stderr.write(`[forge] ${method} ${path}: ${err instanceof Error ? err.stack : String(err)}\n`);
    sendJson(res, 500, JSON.stringify({ message: 'Internal Server Error' }));
    return;
  }
  const extra: Record<string, string> = { 'x-oauth-scopes': SCOPES, 'x-accepted-oauth-scopes': '', 'x-github-media-type': 'github.v3; format=json' };
  if (reply.headers !== undefined) Object.assign(extra, reply.headers);
  sendJson(res, reply.status, reply.body, extra);
}

// ------------------------------------------------------------------ git smart HTTP

const GIT_RE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function serveGit(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray, query: string): Promise<void> {
  const owner = decodeURIComponent(m[1] as string);
  const name = decodeURIComponent(m[2] as string);
  const action = m[3] as string;
  if (authOf(req) === 'bad') {
    send(res, 401, 'Bad credentials\n', { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="forge"' });
    return;
  }
  const repo = findRepo(owner, name);
  const v2 = /version=2/.test(String(req.headers['git-protocol'] ?? ''));
  if (repo === undefined) {
    if (method === 'POST') await readBody(req).catch(() => null);
    send(res, 404, 'Repository not found\n', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  try {
    if (action === 'info/refs' && method === 'GET') {
      const service = new URLSearchParams(query).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        send(res, 403, 'dumb HTTP is not supported\n', { 'content-type': 'text/plain' });
        return;
      }
      send(res, 200, advertisement(repo, service, v2 && service === 'git-upload-pack'), {
        'content-type': `application/x-${service}-advertisement`,
        'cache-control': 'no-cache',
      });
      return;
    }
    if (method !== 'POST') {
      send(res, 405, 'Method Not Allowed\n', { 'content-type': 'text/plain' });
      return;
    }
    const body = await readBody(req);
    if (action === 'git-upload-pack') {
      send(res, 200, uploadPack(repo, body, v2), { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    } else {
      send(res, 200, receivePack(repo, body), { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
    }
  } catch (err) {
    send(res, 400, `${err instanceof Error ? err.message : String(err)}\n`, { 'content-type': 'text/plain; charset=utf-8' });
  }
}

// ------------------------------------------------------------------ the server

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? '' : url.slice(q + 1);
  const method = req.method ?? 'GET';

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await serveRest(req, res, method, path, query);
    return;
  }
  if (path === '/healthz') {
    sendJson(res, 200, '{"ok":true}');
    return;
  }
  if (path === '/api/graphql' || path === '/api/graphql/') {
    const auth = authOf(req);
    const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    if (auth !== 'ok') {
      sendJson(res, 401, JSON.stringify({ message: 'This endpoint requires you to be authenticated.', documentation_url: 'https://docs.github.com/graphql' }));
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, JSON.stringify({ message: 'GraphQL takes POST' }));
      return;
    }
    const out = handleGraphQL(raw);
    sendJson(res, out.status, out.body);
    return;
  }
  if (path === '/mcp' || path === '/mcp/') {
    const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const out = handleMcp(method, raw, authOf(req) === 'ok', req.headers);
    const headers: Record<string, string> = { ...(out.headers ?? {}) };
    if (out.body !== undefined) headers['content-type'] = 'application/json';
    send(res, out.status, out.body, headers);
    return;
  }
  const m = GIT_RE.exec(path);
  if (m !== null) {
    await serveGit(req, res, method, m, query);
    return;
  }
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') await readBody(req).catch(() => null);
  sendJson(res, 404, '{"message":"Not Found"}');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer({ noDelay: true, keepAlive: true, requestTimeout: 0 }, (req, res) => {
    res.sendDate = false;
    route(req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] ${req.method} ${req.url}: ${err instanceof Error ? err.stack : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, JSON.stringify({ message: 'Internal Server Error' }));
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  return server;
}
