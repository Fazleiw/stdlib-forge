// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, answered as
// application/json. It speaks revision 2026-07-28 (server/discover, no session) and the handshake
// revisions (initialize + notifications/initialized). The tools act on the same store as REST.

import type { IncomingHttpHeaders } from 'node:http';
import {
  ApiError,
  VIEWER,
  addComment,
  branchSha,
  commitFiles,
  createIssue,
  createPull,
  createRepo,
  getIssue,
  getPull,
  getRepo,
  listIssues,
  listRepos,
  mergePull,
  objects,
  resolveRef,
  setRef,
  treeOf,
  updateIssue,
} from './store.ts';
import { logFrom } from './git.ts';
import { commentJson, commitJson, issueObject, pullFiles, pullObject, repoObject, userJson } from './rest.ts';

const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-griffin', title: 'Forge Griffin GitHub-compatible forge', version: '1.0.0' };
const INSTRUCTIONS = 'Tools for repositories, issues and pull requests on this GitHub-compatible forge. Repositories belong to the authenticated user.';

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  run: (a: Args) => unknown;
}

const S = (description: string): Record<string, unknown> => ({ type: 'string', description });
const N = (description: string): Record<string, unknown> => ({ type: 'number', description });
const B = (description: string): Record<string, unknown> => ({ type: 'boolean', description });
const OWNER = S('Repository owner (user login)');
const REPO = S('Repository name');

function repoOf(a: Args) {
  return getRepo(String(a.owner), String(a.repo));
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ApiError(422, 'expected an integer number');
  return n;
}

function page<T>(list: T[], a: Args): T[] {
  const perPage = typeof a.perPage === 'number' ? Math.min(100, Math.max(1, a.perPage)) : 30;
  const p = typeof a.page === 'number' ? Math.max(1, a.page) : 1;
  return list.slice((p - 1) * perPage, p * perPage);
}

const TOOLS: Tool[] = [
  {
    name: 'get_me',
    description: 'Get the authenticated user (the owner of every repository on this forge).',
    properties: {},
    required: [],
    run: () => ({ ...userJson(), name: VIEWER.name }),
  },
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: { name: S('Repository name'), description: S('Repository description'), private: B('Whether the repository is private') },
    required: ['name'],
    run: (a) => repoObject(createRepo({ name: a.name, description: a.description, private: a.private === true || a.private === 'true' })),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: { owner: OWNER, repo: REPO },
    required: ['owner', 'repo'],
    run: (a) => repoObject(repoOf(a)),
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user\'s repositories.',
    properties: { page: N('Page number (1-based)'), perPage: N('Results per page (max 100)') },
    required: [],
    run: (a) => page(listRepos(), a).map(repoObject),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    properties: { owner: OWNER, repo: REPO, title: S('Issue title'), body: S('Issue body (markdown)'), labels: { type: 'array', items: { type: 'string' }, description: 'Existing label names to apply' } },
    required: ['owner', 'repo', 'title'],
    run: (a) => issueObject(createIssue(repoOf(a), { title: a.title, body: a.body, labels: a.labels })),
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by number.',
    properties: { owner: OWNER, repo: REPO, issue_number: N('Issue number') },
    required: ['owner', 'repo', 'issue_number'],
    run: (a) => issueObject(getIssue(repoOf(a), num(a.issue_number))),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: OWNER,
      repo: REPO,
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter (default open)' },
      sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Sort field' },
      direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction' },
      page: N('Page number (1-based)'),
      perPage: N('Results per page (max 100)'),
    },
    required: ['owner', 'repo'],
    run: (a) => page(listIssues(repoOf(a), { state: typeof a.state === 'string' ? a.state.toLowerCase() : 'open', sort: a.sort as string | undefined, direction: a.direction as string | undefined }), a).map(issueObject),
  },
  {
    name: 'update_issue',
    description: 'Update an issue\'s title, body, state or labels.',
    properties: { owner: OWNER, repo: REPO, issue_number: N('Issue number'), title: S('New title'), body: S('New body'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' } },
    required: ['owner', 'repo', 'issue_number'],
    run: (a) => {
      const patch: Args = {};
      for (const k of ['title', 'body', 'state']) if (a[k] !== undefined) patch[k] = a[k];
      return issueObject(updateIssue(getIssue(repoOf(a), num(a.issue_number)), patch));
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    properties: { owner: OWNER, repo: REPO, issue_number: N('Issue or pull request number'), body: S('Comment text') },
    required: ['owner', 'repo', 'issue_number', 'body'],
    run: (a) => commentJson(addComment(getIssue(repoOf(a), num(a.issue_number)), a.body)),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: { owner: OWNER, repo: REPO, title: S('Pull request title'), body: S('Pull request description'), head: S('Branch holding the changes'), base: S('Branch to merge into'), draft: B('Open as a draft') },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (a) => pullObject(createPull(repoOf(a), { title: a.title, body: a.body, head: a.head, base: a.base, draft: a.draft })),
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    properties: { owner: OWNER, repo: REPO, pull_number: N('Pull request number') },
    required: ['owner', 'repo', 'pull_number'],
    run: (a) => pullObject(getPull(repoOf(a), num(a.pull_number))),
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    properties: { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State filter (default open)' }, page: N('Page number (1-based)'), perPage: N('Results per page (max 100)') },
    required: ['owner', 'repo'],
    run: (a) => page(listIssues(repoOf(a), { state: typeof a.state === 'string' ? a.state : 'open', pulls: true }), a).map(pullObject),
  },
  {
    name: 'get_pull_request_files',
    description: 'List the files a pull request changes.',
    properties: { owner: OWNER, repo: REPO, pull_number: N('Pull request number') },
    required: ['owner', 'repo', 'pull_number'],
    run: (a) => pullFiles(getPull(repoOf(a), num(a.pull_number))).map((f) => ({ ...f, changes: f.additions + f.deletions })),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (merge, squash or rebase).',
    properties: { owner: OWNER, repo: REPO, pull_number: N('Pull request number'), merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method (default squash)' }, commit_title: S('Title of the merge commit'), commit_message: S('Extra detail for the merge commit') },
    required: ['owner', 'repo', 'pull_number'],
    run: (a) => {
      const sha = mergePull(getPull(repoOf(a), num(a.pull_number)), {
        method: typeof a.merge_method === 'string' ? a.merge_method : 'squash',
        title: typeof a.commit_title === 'string' ? a.commit_title : undefined,
        message: typeof a.commit_message === 'string' ? a.commit_message : undefined,
      });
      return { sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    properties: { owner: OWNER, repo: REPO },
    required: ['owner', 'repo'],
    run: (a) => [...repoOf(a).refs.entries()].filter(([r]) => r.startsWith('refs/heads/')).sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([r, sha]) => ({ name: r.slice(11), commit: { sha }, protected: false })),
  },
  {
    name: 'create_branch',
    description: 'Create a branch from another branch (default: the repository\'s default branch).',
    properties: { owner: OWNER, repo: REPO, branch: S('Name of the new branch'), from_branch: S('Source branch') },
    required: ['owner', 'repo', 'branch'],
    run: (a) => {
      const repo = repoOf(a);
      const from = typeof a.from_branch === 'string' && a.from_branch !== '' ? a.from_branch : repo.defaultBranch;
      const sha = branchSha(repo, from);
      if (sha === undefined) throw new ApiError(404, `branch ${from} not found`);
      if (branchSha(repo, String(a.branch)) !== undefined) throw new ApiError(422, 'Reference already exists');
      setRef(repo, `refs/heads/${String(a.branch)}`, sha);
      return { ref: `refs/heads/${String(a.branch)}`, object: { sha, type: 'commit' } };
    },
  },
  {
    name: 'list_commits',
    description: 'List commits on a branch or from a commit sha.',
    properties: { owner: OWNER, repo: REPO, sha: S('Branch name or commit sha (default branch when omitted)'), page: N('Page number (1-based)'), perPage: N('Results per page (max 100)') },
    required: ['owner', 'repo'],
    run: (a) => {
      const repo = repoOf(a);
      const tip = resolveRef(repo, typeof a.sha === 'string' ? a.sha : null);
      if (tip === null) throw new ApiError(404, 'No commit found');
      return page(logFrom(objects, tip, 10_000), a).map((sha) => commitJson(repo, sha));
    },
  },
  {
    name: 'get_file_contents',
    description: 'Get a file\'s contents (or a directory listing) from a repository.',
    properties: { owner: OWNER, repo: REPO, path: S('Path inside the repository'), ref: S('Branch, tag or sha (default branch when omitted)') },
    required: ['owner', 'repo', 'path'],
    run: (a) => {
      const repo = repoOf(a);
      const tip = resolveRef(repo, typeof a.ref === 'string' ? a.ref : null);
      if (tip === null) throw new ApiError(404, 'No commit found for the ref');
      const flat = treeOf(tip);
      const path = String(a.path).replace(/^\/+|\/+$/g, '');
      const entry = flat.get(path);
      if (entry !== undefined) {
        const data = objects.get(entry.oid)?.data ?? Buffer.alloc(0);
        return { type: 'file', path, sha: entry.oid, size: data.length, encoding: 'utf-8', content: data.toString('utf8') };
      }
      const prefix = path === '' ? '' : `${path}/`;
      const names = new Set<string>();
      for (const p of flat.keys()) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0] as string);
      if (names.size === 0) throw new ApiError(404, 'Not Found');
      return [...names].sort().map((name) => ({ name, path: `${prefix}${name}`, type: flat.has(`${prefix}${name}`) ? 'file' : 'dir' }));
    },
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update one file with a commit on a branch.',
    properties: { owner: OWNER, repo: REPO, path: S('Path inside the repository'), content: S('New file content (plain text)'), message: S('Commit message'), branch: S('Branch (default branch when omitted)'), sha: S('Current blob sha when updating') },
    required: ['owner', 'repo', 'path', 'content', 'message'],
    run: (a) => {
      const repo = repoOf(a);
      const branch = typeof a.branch === 'string' && a.branch !== '' ? a.branch : repo.defaultBranch;
      const path = String(a.path);
      const tip = branchSha(repo, branch);
      const existing = tip === undefined ? undefined : treeOf(tip).get(path);
      if (existing !== undefined && typeof a.sha === 'string' && a.sha !== existing.oid) throw new ApiError(409, `${path} does not match ${a.sha}`);
      const result = commitFiles(repo, branch, [{ path, content: Buffer.from(String(a.content), 'utf8') }], String(a.message));
      return { content: { path, sha: result.blobs.get(path) }, commit: { sha: result.commit } };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const TOOLS_LIST = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: { type: 'object', properties: t.properties, required: t.required, additionalProperties: false },
  annotations: { readOnlyHint: /^(get|list)_/.test(t.name) },
}));

// ------------------------------------------------------------------ JSON-RPC

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function callTool(id: RpcId, params: Record<string, unknown>): Record<string, unknown> {
  const name = params.name;
  const tool = typeof name === 'string' ? TOOL_BY_NAME.get(name) ?? TOOL_BY_NAME.get(name.replace(/^.*__/, '').toLowerCase()) : undefined;
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
  const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Args) : {};
  const missing = tool.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length > 0) {
    return rpcResult(id, { content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }], isError: true });
  }
  try {
    const value = tool.run(args);
    return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
  } catch (err) {
    const message = err instanceof ApiError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : String(err);
    return rpcResult(id, { content: [{ type: 'text', text: `error: ${message}` }], isError: true });
  }
}

function dispatch(msg: unknown): Record<string, unknown> | null {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
  const m = msg as Record<string, unknown>;
  const id = (typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null) as RpcId;
  const isNotification = !('id' in m);
  if (typeof m.method !== 'string') {
    if ('result' in m || 'error' in m) return null;
    return rpcError(id, -32600, 'Invalid Request');
  }
  const params = m.params !== null && typeof m.params === 'object' && !Array.isArray(m.params) ? (m.params as Record<string, unknown>) : {};
  if (isNotification) return null;
  switch (m.method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const asked = params.protocolVersion;
      const version = typeof asked === 'string' && SUPPORTED.includes(asked) ? asked : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS_LIST });
    case 'tools/call':
      return callTool(id, params);
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${m.method}`);
  }
}

export function handleMcp(method: string, raw: Buffer, authed: boolean, headers: IncomingHttpHeaders): { status: number; body?: string; headers?: Record<string, string> } {
  void headers;
  if (!authed) {
    return {
      status: 401,
      body: JSON.stringify(rpcError(null, -32001, 'Unauthorized: a Bearer token is required')),
      headers: { 'www-authenticate': 'Bearer realm="forge"' },
    };
  }
  if (method === 'DELETE') return { status: 204 };
  if (method !== 'POST') return { status: 405, body: JSON.stringify(rpcError(null, -32000, 'Method not allowed')), headers: { allow: 'POST, DELETE' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed.map(dispatch).filter((r): r is Record<string, unknown> => r !== null);
    return replies.length === 0 ? { status: 202 } : { status: 200, body: JSON.stringify(replies) };
  }
  const reply = dispatch(parsed);
  return reply === null ? { status: 202 } : { status: 200, body: JSON.stringify(reply) };
}
