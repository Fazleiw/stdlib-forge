// GitHub REST v3 under /api/v3: repositories, refs, branches, commits, contents, labels, issues,
// comments and pull requests (with files and squash/merge). Handlers return a Reply; app.ts writes it.
// JSON objects are GitHub-shaped. API urls inside bodies use a fixed origin (no port, so a replay
// serves the same bytes); only the Link pagination header carries the request's own Host.

import { flattenTree, isAncestor, isOid, logFrom, mergeBase, parseIdent, type FlatTree } from './git.ts';
import {
  ApiError,
  VIEWER,
  addComment,
  branchSha,
  commitFiles,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteRepo,
  getIssue,
  getPull,
  getRepo,
  isMergeable,
  iso,
  listIssues,
  listRepos,
  mergePull,
  nodeId,
  objects,
  pullBaseSha,
  pullHeadSha,
  resolveRef,
  setRef,
  tick,
  treeOf,
  updateIssue,
  updateRepo,
  type Comment,
  type Issue,
  type Label,
  type Repo,
} from './store.ts';

export interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export const ORIGIN = 'https://forge.local';
const API = `${ORIGIN}/api/v3`;

export function json(status: number, value: unknown, headers?: Record<string, string>): Reply {
  return { status, body: JSON.stringify(value), headers };
}

// ------------------------------------------------------------------ renderers

let userJsonCache: Record<string, unknown> | null = null;
export function userJson(): Record<string, unknown> {
  userJsonCache ??= {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: nodeId('User', VIEWER.id),
    avatar_url: `${ORIGIN}/avatars/${VIEWER.login}`,
    gravatar_id: '',
    url: `${API}/users/${VIEWER.login}`,
    html_url: `${ORIGIN}/${VIEWER.login}`,
    repos_url: `${API}/users/${VIEWER.login}/repos`,
    type: 'User',
    site_admin: false,
  };
  return userJsonCache;
}

export function repoObject(repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const open = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(),
    html_url: `${ORIGIN}/${full}`,
    description: repo.description,
    fork: false,
    url: `${API}/repos/${full}`,
    git_url: `git://forge.local/${full}.git`,
    clone_url: `${ORIGIN}/${full}.git`,
    created_at: iso(repo.created),
    updated_at: iso(repo.updated),
    pushed_at: repo.pushed === null ? null : iso(repo.pushed),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: open,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
  };
}

function repoJsonText(repo: Repo): string {
  repo.json ??= JSON.stringify(repoObject(repo));
  return repo.json;
}

export function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `${API}/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueObject(issue: Issue): Record<string, unknown> {
  const repo = issue.repo;
  const base = `${API}/repos/${repo.owner}/${repo.name}`;
  const out: Record<string, unknown> = {
    id: issue.id,
    node_id: nodeId(issue.pull === null ? 'Issue' : 'PullRequest', issue.id),
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    comments_url: `${base}/issues/${issue.number}/comments`,
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/${issue.pull === null ? 'issues' : 'pull'}/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.stateReason,
    locked: false,
    labels: issue.labels.map((l) => labelJson(repo, l)),
    user: userJson(),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    author_association: 'OWNER',
    created_at: iso(issue.created),
    updated_at: iso(issue.updated),
    closed_at: issue.closed === null ? null : iso(issue.closed),
  };
  if (issue.pull !== null) {
    out.pull_request = {
      url: `${base}/pulls/${issue.number}`,
      html_url: `${ORIGIN}/${repo.owner}/${repo.name}/pull/${issue.number}`,
      merged_at: issue.pull.mergedAt === null ? null : iso(issue.pull.mergedAt),
    };
  }
  return out;
}

export function issueJsonText(issue: Issue): string {
  issue.json ??= JSON.stringify(issueObject(issue));
  return issue.json;
}

export function commentJson(c: Comment): Record<string, unknown> {
  const repo = c.issue.repo;
  return {
    id: c.id,
    node_id: nodeId('IssueComment', c.id),
    url: `${API}/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/issues/${c.issue.number}#issuecomment-${c.id}`,
    issue_url: `${API}/repos/${repo.owner}/${repo.name}/issues/${c.issue.number}`,
    body: c.body,
    user: userJson(),
    author_association: 'OWNER',
    created_at: iso(c.created),
    updated_at: iso(c.updated),
  };
}

function gitPerson(ident: string): { name: string; email: string; date: string } {
  const p = parseIdent(ident);
  return { name: p.name, email: p.email, date: iso(p.time) };
}

/** The `commit` object the contents API answers with. */
function gitCommitJson(repo: Repo, sha: string): Record<string, unknown> {
  const c = objects.commit(sha);
  const base = `${API}/repos/${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: nodeId('Commit', parseInt(sha.slice(0, 12), 16)),
    url: `${base}/git/commits/${sha}`,
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/commit/${sha}`,
    author: c === null ? null : gitPerson(c.author),
    committer: c === null ? null : gitPerson(c.committer),
    tree: { sha: c?.tree ?? '', url: `${base}/git/trees/${c?.tree ?? ''}` },
    message: (c?.message ?? '').replace(/\n$/, ''),
    parents: (c?.parents ?? []).map((p) => ({ sha: p, url: `${base}/git/commits/${p}`, html_url: `${ORIGIN}/${repo.owner}/${repo.name}/commit/${p}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

/** The commit object /commits lists. */
export function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const c = objects.commit(sha);
  const base = `${API}/repos/${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: nodeId('Commit', parseInt(sha.slice(0, 12), 16)),
    commit: {
      author: c === null ? null : gitPerson(c.author),
      committer: c === null ? null : gitPerson(c.committer),
      message: (c?.message ?? '').replace(/\n$/, ''),
      tree: { sha: c?.tree ?? '', url: `${base}/git/trees/${c?.tree ?? ''}` },
      url: `${base}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${base}/commits/${sha}`,
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${base}/commits/${sha}/comments`,
    author: userJson(),
    committer: userJson(),
    parents: (c?.parents ?? []).map((p) => ({ sha: p, url: `${base}/commits/${p}`, html_url: `${ORIGIN}/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

function lineStats(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const lines = (b: Buffer | null): string[] => {
    if (b === null || b.length === 0) return [];
    const parts = b.toString('utf8').split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const a = lines(before);
  const b = lines(after);
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of b) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of counts.values()) deletions += n;
  return { additions, deletions };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  sha: string;
}

export function diffTrees(from: FlatTree, to: FlatTree): ChangedFile[] {
  const out: ChangedFile[] = [];
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  for (const path of paths) {
    const a = from.get(path);
    const b = to.get(path);
    if (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode) continue;
    const before = a === undefined ? null : objects.get(a.oid)?.data ?? null;
    const after = b === undefined ? null : objects.get(b.oid)?.data ?? null;
    const stats = lineStats(before, after);
    out.push({ filename: path, status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified', ...stats, sha: (b ?? a)?.oid ?? '' });
  }
  return out;
}

export function pullFiles(issue: Issue): ChangedFile[] {
  const headSha = pullHeadSha(issue);
  const baseSha = pullBaseSha(issue);
  const mb = issue.pull?.merged === true ? baseSha : (mergeBaseOf(baseSha, headSha) ?? baseSha);
  return diffTrees(treeOf(mb), treeOf(headSha));
}

function mergeBaseOf(a: string, b: string): string | null {
  return objects.commit(a) === null || objects.commit(b) === null ? null : mergeBase(objects, a, b);
}

function pullCommitCount(issue: Issue): number {
  const headSha = pullHeadSha(issue);
  const baseSha = pullBaseSha(issue);
  const ancestors = new Set<string>();
  const st = [baseSha];
  while (st.length > 0) {
    const o = st.pop() as string;
    if (ancestors.has(o)) continue;
    ancestors.add(o);
    st.push(...(objects.commit(o)?.parents ?? []));
  }
  let n = 0;
  const seen = new Set<string>();
  const q = [headSha];
  while (q.length > 0) {
    const o = q.pop() as string;
    if (seen.has(o) || ancestors.has(o)) continue;
    seen.add(o);
    n += 1;
    q.push(...(objects.commit(o)?.parents ?? []));
  }
  return n;
}

export function pullObject(issue: Issue): Record<string, unknown> {
  const repo = issue.repo;
  const p = issue.pull;
  if (p === null) return issueObject(issue);
  const base = `${API}/repos/${repo.owner}/${repo.name}`;
  const files = pullFiles(issue);
  const mergeable = issue.state === 'open' ? isMergeable(issue) : null;
  const branch = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoObject(repo),
  });
  return {
    url: `${base}/pulls/${issue.number}`,
    id: issue.id,
    node_id: nodeId('PullRequest', issue.id),
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/pull/${issue.number}`,
    diff_url: `${ORIGIN}/${repo.owner}/${repo.name}/pull/${issue.number}.diff`,
    patch_url: `${ORIGIN}/${repo.owner}/${repo.name}/pull/${issue.number}.patch`,
    issue_url: `${base}/issues/${issue.number}`,
    commits_url: `${base}/pulls/${issue.number}/commits`,
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    body: issue.body ?? '',
    user: userJson(),
    labels: issue.labels.map((l) => labelJson(repo, l)),
    milestone: null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    created_at: iso(issue.created),
    updated_at: iso(issue.updated),
    closed_at: issue.closed === null ? null : iso(issue.closed),
    merged_at: p.mergedAt === null ? null : iso(p.mergedAt),
    merge_commit_sha: p.mergeCommitSha,
    head: branch(p.head, pullHeadSha(issue)),
    base: branch(p.base, pullBaseSha(issue)),
    author_association: 'OWNER',
    draft: p.draft,
    merged: p.merged,
    mergeable,
    mergeable_state: issue.state !== 'open' ? 'unknown' : mergeable ? 'clean' : 'dirty',
    merged_by: p.merged ? userJson() : null,
    comments: issue.comments.length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: pullCommitCount(issue),
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    changed_files: files.length,
  };
}

function fileJson(repo: Repo, path: string, oid: string, size: number, ref: string): Record<string, unknown> {
  const base = `${API}/repos/${repo.owner}/${repo.name}`;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const url = `${base}/contents/${path}?ref=${ref}`;
  return {
    type: 'file',
    name,
    path,
    sha: oid,
    size,
    url,
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
    git_url: `${base}/git/blobs/${oid}`,
    download_url: `${ORIGIN}/${repo.owner}/${repo.name}/raw/${ref}/${path}`,
    _links: { self: url, git: `${base}/git/blobs/${oid}`, html: `${ORIGIN}/${repo.owner}/${repo.name}/blob/${ref}/${path}` },
  };
}

// ------------------------------------------------------------------ helpers

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function intParam(q: URLSearchParams, name: string, dflt: number, max: number): number {
  const raw = q.get(name);
  const n = raw === null ? dflt : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
}

function paginate<T>(items: T[], q: URLSearchParams, host: string, path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = intParam(q, 'per_page', 30, 100);
  const page = intParam(q, 'page', 1, 1_000_000);
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const link = (n: number): string => {
    const params = new URLSearchParams(q);
    params.set('per_page', String(perPage));
    params.set('page', String(n));
    return `<http://${host}${path}?${params.toString()}>`;
  };
  const rels: string[] = [];
  if (page < last) rels.push(`${link(page + 1)}; rel="next"`, `${link(last)}; rel="last"`);
  if (page > 1) rels.push(`${link(1)}; rel="first"`, `${link(Math.min(page - 1, last))}; rel="prev"`);
  return { page: slice, headers: rels.length > 0 ? { link: rels.join(', ') } : {} };
}

function listReply<T>(items: T[], q: URLSearchParams, host: string, path: string, render: (item: T) => unknown): Reply {
  const { page, headers } = paginate(items, q, host, path);
  return json(200, page.map(render), headers);
}

function rawList(items: string[], q: URLSearchParams, host: string, path: string): Reply {
  const { page, headers } = paginate(items, q, host, path);
  return { status: 200, body: `[${page.join(',')}]`, headers };
}

function requireObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Problems parsing JSON');
  return body as Record<string, unknown>;
}

function decodeContent(content: unknown): Buffer {
  if (typeof content !== 'string') throw new ApiError(422, 'Invalid request: "content" wasn\'t supplied.');
  return Buffer.from(content.replace(/\s+/g, ''), 'base64');
}

function refJson(repo: Repo, ref: string, sha: string): Record<string, unknown> {
  const obj = objects.get(sha);
  return {
    ref,
    node_id: nodeId('Ref', repo.id),
    url: `${API}/repos/${repo.owner}/${repo.name}/git/${ref}`,
    object: { sha, type: obj?.type ?? 'commit', url: `${API}/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  };
}

function branchJson(repo: Repo, name: string, sha: string, full: boolean): Record<string, unknown> {
  const base = `${API}/repos/${repo.owner}/${repo.name}`;
  if (!full) return { name, commit: { sha, url: `${base}/commits/${sha}` }, protected: false };
  return {
    name,
    commit: commitJson(repo, sha),
    protected: false,
    _links: { self: `${base}/branches/${name}`, html: `${ORIGIN}/${repo.owner}/${repo.name}/tree/${name}` },
  };
}

// ------------------------------------------------------------------ the router

/**
 * One REST request. `segs` are the decoded path segments after /api/v3; `body` is the parsed JSON
 * body (undefined when there was none).
 */
export function handleRest(method: string, segs: string[], q: URLSearchParams, body: unknown, host: string, path: string): Reply {
  const n = segs.length;
  const s0 = segs[0] ?? '';
  if (n === 0) {
    if (method === 'GET') {
      return json(200, {
        current_user_url: `${API}/user`,
        repository_url: `${API}/repos/{owner}/{repo}`,
        user_repositories_url: `${API}/user/repos`,
        rate_limit_url: `${API}/rate_limit`,
      });
    }
    throw new ApiError(404, 'Not Found');
  }
  if (s0 === 'meta' && n === 1 && method === 'GET') {
    return json(200, { verifiable_password_authentication: false, installed_version: '3.14.0', hooks: [], git: [], web: [], api: [] });
  }
  if (s0 === 'rate_limit' && n === 1 && method === 'GET') {
    const core = { limit: 5000, used: 0, remaining: 5000, reset: 0 };
    return json(200, { resources: { core, graphql: core }, rate: core });
  }
  if (s0 === 'user' && n === 1 && method === 'GET') return json(200, { ...userJson(), name: VIEWER.name, email: VIEWER.email });
  if (s0 === 'users' && n === 2 && method === 'GET') {
    if ((segs[1] ?? '').toLowerCase() !== VIEWER.login.toLowerCase()) throw new ApiError(404, 'Not Found');
    return json(200, userJson());
  }
  if (s0 === 'user' && segs[1] === 'repos' && n === 2) {
    if (method === 'GET') return listReply(listRepos(), q, host, path, repoObject);
    if (method === 'POST') return json(201, repoObject(createRepo(requireObject(body))));
  }
  if (s0 === 'users' && segs[2] === 'repos' && n === 3 && method === 'GET') {
    const items = (segs[1] ?? '').toLowerCase() === VIEWER.login.toLowerCase() ? listRepos() : [];
    return listReply(items, q, host, path, repoObject);
  }
  if (s0 === 'repos' && n >= 3) return repoRoutes(method, segs, q, requireObject(body), host, path);
  throw new ApiError(404, 'Not Found');
}

function repoRoutes(method: string, segs: string[], q: URLSearchParams, body: Record<string, unknown>, host: string, path: string): Reply {
  const repo = getRepo(segs[1] as string, segs[2] as string);
  const n = segs.length;
  const s3 = segs[3];
  if (n === 3) {
    if (method === 'GET') return { status: 200, body: repoJsonText(repo) };
    if (method === 'PATCH') return json(200, repoObject(updateRepo(repo, body)));
    if (method === 'DELETE') {
      deleteRepo(repo);
      return { status: 204 };
    }
    throw new ApiError(404, 'Not Found');
  }
  switch (s3) {
    case 'git':
      return gitRoutes(repo, method, segs.slice(4), body, q, host, path);
    case 'branches':
      if (n === 4 && method === 'GET') {
        const items = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/heads/')).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        return listReply(items, q, host, path, ([r, sha]) => branchJson(repo, r.slice(11), sha, false));
      }
      if (n >= 5 && method === 'GET') {
        const name = segs.slice(4).join('/');
        const sha = branchSha(repo, name);
        if (sha === undefined) throw new ApiError(404, 'Branch not found');
        return json(200, branchJson(repo, name, sha, true));
      }
      break;
    case 'commits':
      if (n === 4 && method === 'GET') {
        if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
        const tip = resolveRef(repo, q.get('sha'));
        if (tip === null) throw new ApiError(404, 'No commit found for SHA: ' + (q.get('sha') ?? ''));
        let shas = logFrom(objects, tip, 10_000);
        const filter = q.get('path');
        if (filter !== null && filter !== '') {
          shas = shas.filter((sha) => {
            const c = objects.commit(sha);
            if (c === null) return false;
            const mine = flattenTree(objects, c.tree).get(filter)?.oid;
            const parent = c.parents[0] === undefined ? undefined : treeOf(c.parents[0]).get(filter)?.oid;
            return mine !== parent;
          });
        }
        return listReply(shas, q, host, path, (sha) => commitJson(repo, sha));
      }
      if (n >= 5 && method === 'GET') {
        const sha = resolveRef(repo, segs.slice(4).join('/'));
        if (sha === null) throw new ApiError(404, 'No commit found');
        const c = objects.commit(sha);
        const files = diffTrees(treeOf(c?.parents[0] ?? null), treeOf(sha));
        return json(200, { ...commitJson(repo, sha), files: files.map((f) => ({ ...f, changes: f.additions + f.deletions })) });
      }
      break;
    case 'contents':
      return contentsRoutes(repo, method, segs.slice(4).join('/'), q, body);
    case 'labels':
      if (n === 4 && method === 'GET') return listReply([...repo.labels.values()], q, host, path, (l) => labelJson(repo, l));
      if (n === 4 && method === 'POST') return json(201, labelJson(repo, createLabel(repo, body)));
      if (n === 5 && method === 'GET') {
        const label = repo.labels.get((segs[4] ?? '').toLowerCase());
        if (label === undefined) throw new ApiError(404, 'Not Found');
        return json(200, labelJson(repo, label));
      }
      if (n === 5 && method === 'DELETE') {
        if (!repo.labels.delete((segs[4] ?? '').toLowerCase())) throw new ApiError(404, 'Not Found');
        return { status: 204 };
      }
      break;
    case 'issues':
      return issueRoutes(repo, method, segs, q, body, host, path);
    case 'pulls':
      return pullRoutes(repo, method, segs, q, body, host, path);
    default:
      break;
  }
  throw new ApiError(404, 'Not Found');
}

function gitRoutes(repo: Repo, method: string, rest: string[], body: Record<string, unknown>, q: URLSearchParams, host: string, path: string): Reply {
  const kind = rest[0];
  if ((kind === 'refs' || kind === 'ref') && method === 'POST' && rest.length === 1) {
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (ref === undefined || !ref.startsWith('refs/') || ref.split('/').length < 3) throw new ApiError(422, 'Reference name is invalid');
    if (sha === undefined || !isOid(sha) || !objects.has(sha)) throw new ApiError(422, 'Object does not exist');
    if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
    setRef(repo, ref, sha);
    return json(201, refJson(repo, ref, sha));
  }
  if (kind === 'refs' || kind === 'ref') {
    const name = rest.slice(1).join('/');
    const ref = name.startsWith('refs/') ? name : `refs/${name}`;
    if (method === 'GET') {
      const sha = repo.refs.get(ref);
      if (sha !== undefined) return json(200, refJson(repo, ref, sha));
      const matches = [...repo.refs.entries()].filter(([r]) => name === '' || r.startsWith(`${ref}/`)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (kind === 'refs' && matches.length > 0) return listReply(matches, q, host, path, ([r, s]) => refJson(repo, r, s));
      throw new ApiError(404, 'Not Found');
    }
    if (method === 'PATCH') {
      const current = repo.refs.get(ref);
      const sha = str(body.sha);
      if (current === undefined) throw new ApiError(422, 'Reference does not exist');
      if (sha === undefined || !objects.has(sha)) throw new ApiError(422, 'Object does not exist');
      if (body.force !== true) {
        const a = objects.peelToCommit(current);
        const b = objects.peelToCommit(sha);
        if (a === null || b === null || !isAncestorOf(a, b)) throw new ApiError(422, 'Update is not a fast forward');
      }
      setRef(repo, ref, sha);
      return json(200, refJson(repo, ref, sha));
    }
    if (method === 'DELETE') {
      if (!repo.refs.has(ref)) throw new ApiError(422, 'Reference does not exist');
      setRef(repo, ref, null);
      return { status: 204 };
    }
  }
  if (kind === 'commits' && rest.length === 2 && method === 'GET') {
    const sha = rest[1] as string;
    if (objects.commit(sha) === null) throw new ApiError(404, 'Not Found');
    return json(200, gitCommitJson(repo, sha));
  }
  if (kind === 'blobs' && rest.length === 2 && method === 'GET') {
    const obj = objects.get(rest[1] as string);
    if (obj === undefined || obj.type !== 'blob') throw new ApiError(404, 'Not Found');
    return json(200, { sha: rest[1], size: obj.data.length, encoding: 'base64', content: obj.data.toString('base64'), node_id: nodeId('Blob', 1) });
  }
  if (kind === 'trees' && rest.length === 2 && method === 'GET') {
    const sha = resolveTreeish(repo, rest[1] as string);
    const entries = sha === null ? null : objects.tree(sha);
    if (sha === null || entries === null) throw new ApiError(404, 'Not Found');
    const recursive = q.get('recursive') !== null;
    const tree: unknown[] = [];
    const walk = (oid: string, prefix: string): void => {
      for (const e of objects.tree(oid) ?? []) {
        const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
        const isDir = e.mode === '40000';
        tree.push({ path: p, mode: isDir ? '040000' : e.mode, type: isDir ? 'tree' : 'blob', sha: e.oid, ...(isDir ? {} : { size: objects.get(e.oid)?.data.length ?? 0 }) });
        if (isDir && recursive) walk(e.oid, p);
      }
    };
    walk(sha, '');
    return json(200, { sha, tree, truncated: false });
  }
  throw new ApiError(404, 'Not Found');
}

function isAncestorOf(a: string, b: string): boolean {
  return isAncestor(objects, a, b);
}

function resolveTreeish(repo: Repo, name: string): string | null {
  const obj = objects.get(name);
  if (obj !== undefined && obj.type === 'tree') return name;
  const commit = resolveRef(repo, name);
  return commit === null ? null : (objects.commit(commit)?.tree ?? null);
}

function contentsRoutes(repo: Repo, method: string, filePath: string, q: URLSearchParams, body: Record<string, unknown>): Reply {
  const path = filePath.replace(/^\/+|\/+$/g, '');
  if (method === 'GET') {
    const refName = q.get('ref');
    if (repo.refs.size === 0) throw new ApiError(404, 'This repository is empty.');
    const commit = resolveRef(repo, refName);
    if (commit === null) throw new ApiError(404, `No commit found for the ref ${refName ?? ''}`);
    const ref = refName ?? repo.defaultBranch;
    const root = objects.commit(commit)?.tree as string;
    let oid = root;
    let mode = '40000';
    if (path !== '') {
      for (const part of path.split('/')) {
        if (mode !== '40000') throw new ApiError(404, 'Not Found');
        const entry = objects.tree(oid)?.find((e) => e.name === part);
        if (entry === undefined) throw new ApiError(404, 'Not Found');
        oid = entry.oid;
        mode = entry.mode;
      }
    }
    if (mode === '40000') {
      const entries = (objects.tree(oid) ?? []).map((e) => {
        const p = path === '' ? e.name : `${path}/${e.name}`;
        if (e.mode === '40000') {
          return { type: 'dir', name: e.name, path: p, sha: e.oid, size: 0, url: `${API}/repos/${repo.owner}/${repo.name}/contents/${p}?ref=${ref}` };
        }
        return fileJson(repo, p, e.oid, objects.get(e.oid)?.data.length ?? 0, ref);
      });
      return json(200, entries);
    }
    const data = objects.get(oid)?.data ?? Buffer.alloc(0);
    const b64 = data.toString('base64').replace(/(.{60})/g, '$1\n');
    return json(200, { ...fileJson(repo, path, oid, data.length, ref), content: b64.endsWith('\n') ? b64 : `${b64}\n`, encoding: 'base64' });
  }
  if (path === '') throw new ApiError(404, 'Not Found');
  const message = str(body.message);
  const branchArg = str(body.branch);
  const branch = branchArg ?? repo.defaultBranch;
  let tip = branchSha(repo, branch);
  if (tip === undefined && branchArg !== undefined && repo.refs.size > 0) {
    // A write naming a branch that does not exist yet starts it from the default branch.
    const from = branchSha(repo, repo.defaultBranch);
    if (from === undefined) throw new ApiError(404, `Branch ${branch} not found`);
    setRef(repo, `refs/heads/${branch}`, from);
    tip = from;
  }
  const existing = tip === undefined ? undefined : treeOf(tip).get(path);
  if (method === 'PUT') {
    if (message === undefined) throw new ApiError(422, 'Invalid request: "message" wasn\'t supplied.');
    const content = decodeContent(body.content);
    const sha = str(body.sha);
    if (existing !== undefined) {
      if (sha === undefined) throw new ApiError(422, 'Invalid request: "sha" wasn\'t supplied.');
      if (sha !== existing.oid) throw new ApiError(409, `${path} does not match ${sha}`);
    } else if (sha !== undefined && tip !== undefined) {
      throw new ApiError(409, `${path} does not match ${sha}`);
    }
    const result = commitFiles(repo, branch, [{ path, content }], message);
    const blob = result.blobs.get(path) as string;
    return json(existing === undefined ? 201 : 200, {
      content: { ...fileJson(repo, path, blob, content.length, branch), encoding: 'base64' },
      commit: gitCommitJson(repo, result.commit),
    });
  }
  if (method === 'DELETE') {
    if (message === undefined) throw new ApiError(422, 'Invalid request: "message" wasn\'t supplied.');
    if (existing === undefined) throw new ApiError(404, 'Not Found');
    const sha = str(body.sha);
    if (sha === undefined) throw new ApiError(422, 'Invalid request: "sha" wasn\'t supplied.');
    if (sha !== existing.oid) throw new ApiError(409, `${path} does not match ${sha}`);
    const result = commitFiles(repo, branch, [{ path, content: null }], message);
    return json(200, { content: null, commit: gitCommitJson(repo, result.commit) });
  }
  throw new ApiError(404, 'Not Found');
}

function issueNumberOf(seg: string | undefined): number {
  if (seg === undefined || !/^\d+$/.test(seg)) throw new ApiError(404, 'Not Found');
  return Number(seg);
}

function issueRoutes(repo: Repo, method: string, segs: string[], q: URLSearchParams, body: Record<string, unknown>, host: string, path: string): Reply {
  const n = segs.length;
  if (n === 4) {
    if (method === 'GET') {
      const list = listIssues(repo, {
        state: q.get('state') ?? 'open',
        sort: q.get('sort') ?? 'created',
        direction: q.get('direction') ?? 'desc',
        labels: q.get('labels') ?? undefined,
      });
      return rawList(list.map(issueJsonText), q, host, path);
    }
    if (method === 'POST') return { status: 201, body: issueJsonText(createIssue(repo, body)) };
  }
  if (n === 5 && segs[4] === 'comments' && method === 'GET') {
    const all = [...repo.issues.values()].flatMap((i) => i.comments).sort((a, b) => a.id - b.id);
    return listReply(all, q, host, path, commentJson);
  }
  if (n === 6 && segs[4] === 'comments') {
    const id = Number(segs[5]);
    for (const issue of repo.issues.values()) {
      const c = issue.comments.find((x) => x.id === id);
      if (c === undefined) continue;
      if (method === 'GET') return json(200, commentJson(c));
      if (method === 'PATCH') {
        if (typeof body.body !== 'string') throw new ApiError(422, 'Validation Failed: body is required');
        c.body = body.body;
        c.updated = tick();
        return json(200, commentJson(c));
      }
      if (method === 'DELETE') {
        issue.comments.splice(issue.comments.indexOf(c), 1);
        issue.json = null;
        return { status: 204 };
      }
    }
    throw new ApiError(404, 'Not Found');
  }
  const issue = getIssue(repo, issueNumberOf(segs[4]));
  if (n === 5) {
    if (method === 'GET') return { status: 200, body: issueJsonText(issue) };
    if (method === 'PATCH') return { status: 200, body: issueJsonText(updateIssue(issue, body)) };
  }
  if (n === 6 && segs[5] === 'comments') {
    if (method === 'GET') return listReply(issue.comments, q, host, path, commentJson);
    if (method === 'POST') return json(201, commentJson(addComment(issue, body.body)));
  }
  if (n === 6 && segs[5] === 'labels') {
    if (method === 'GET') return json(200, issue.labels.map((l) => labelJson(repo, l)));
    if (method === 'POST' || method === 'PUT') {
      const names = Array.isArray(body.labels) ? body.labels : Array.isArray(body) ? body : [];
      updateIssue(issue, { labels: method === 'PUT' ? names : [...issue.labels.map((l) => l.name), ...names] });
      return json(200, issue.labels.map((l) => labelJson(repo, l)));
    }
  }
  throw new ApiError(404, 'Not Found');
}


function pullRoutes(repo: Repo, method: string, segs: string[], q: URLSearchParams, body: Record<string, unknown>, host: string, path: string): Reply {
  const n = segs.length;
  if (n === 4) {
    if (method === 'GET') {
      let list = listIssues(repo, { state: q.get('state') ?? 'open', sort: q.get('sort') ?? 'created', direction: q.get('direction') ?? 'desc', pulls: true });
      const head = q.get('head');
      const base = q.get('base');
      if (head !== null) list = list.filter((i) => i.pull?.head === head.slice(head.indexOf(':') + 1));
      if (base !== null) list = list.filter((i) => i.pull?.base === base);
      return listReply(list, q, host, path, pullObject);
    }
    if (method === 'POST') return json(201, pullObject(createPull(repo, body)));
  }
  const issue = getPull(repo, issueNumberOf(segs[4]));
  if (n === 5) {
    if (method === 'GET') return json(200, pullObject(issue));
    if (method === 'PATCH') {
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'body', 'state']) if (body[k] !== undefined) patch[k] = body[k];
      updateIssue(issue, patch);
      if (typeof body.base === 'string' && branchSha(repo, body.base) !== undefined && issue.pull !== null) issue.pull.base = body.base;
      return json(200, pullObject(issue));
    }
  }
  if (n === 6 && segs[5] === 'files' && method === 'GET') {
    const owner = `${repo.owner}/${repo.name}`;
    return listReply(pullFiles(issue), q, host, path, (f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
      blob_url: `${ORIGIN}/${owner}/blob/${pullHeadSha(issue)}/${f.filename}`,
      raw_url: `${ORIGIN}/${owner}/raw/${pullHeadSha(issue)}/${f.filename}`,
      contents_url: `${API}/repos/${owner}/contents/${f.filename}?ref=${pullHeadSha(issue)}`,
    }));
  }
  if (n === 6 && segs[5] === 'commits' && method === 'GET') {
    const base = new Set(logFrom(objects, pullBaseSha(issue), 100_000));
    const shas = logFrom(objects, pullHeadSha(issue), 10_000).filter((s) => !base.has(s)).reverse();
    return listReply(shas, q, host, path, (sha) => commitJson(repo, sha));
  }
  if (n === 6 && segs[5] === 'merge') {
    if (method === 'GET') {
      if (issue.pull?.merged === true) return { status: 204 };
      throw new ApiError(404, 'Not Found');
    }
    if (method === 'PUT') {
      const sha = mergePull(issue, {
        method: str(body.merge_method),
        title: str(body.commit_title),
        message: str(body.commit_message),
        sha: str(body.sha),
      });
      return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
  }
  throw new ApiError(404, 'Not Found');
}
