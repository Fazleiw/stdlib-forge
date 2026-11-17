// The forge's state: one viewer, their repositories (refs over the shared object store), issues,
// pull requests, labels and comments, plus every operation the REST, GraphQL and MCP surfaces share.
//
// Determinism: no wall clock and no randomness. Time is MAKEFUN_TRIAL_NOW plus one second per
// mutation (a logical clock), and every id is a counter, so a replayed trial serves identical bytes.

import {
  ObjectStore,
  ZERO,
  buildCommit,
  flattenTree,
  isAncestor,
  mergeBase,
  writeFlatTree,
  type FlatTree,
} from './git.ts';

export class ApiError extends Error {
  status: number;
  extra: Record<string, unknown> | undefined;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ------------------------------------------------------------------ clock, ids, viewer

function trialEpoch(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return Math.floor(n > 1e11 ? n / 1000 : n);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_763_683_200;
}

let clockBase = trialEpoch();
let ticks = 0;

/** The next logical second (advances once per mutation). */
export function tick(): number {
  ticks += 1;
  return clockBase + ticks;
}

export function iso(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 19)}Z`;
}

let nextId = 1000;
export function newId(): number {
  nextId += 1;
  return nextId;
}

export const VIEWER = {
  login: process.env.FORGE_VIEWER_LOGIN ?? 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};
export const VIEWER_IDENT = `${VIEWER.name} <${VIEWER.email}>`;

/** Opaque, stable global ids: base64 of "<kind>:<id>". */
export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64').replace(/=+$/, '');
}

export function decodeNodeId(id: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    return m === null ? null : { kind: m[1] as string, id: Number(m[2]) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the model

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  created: number;
  updated: number;
  issue: Issue;
}

export interface PullData {
  head: string;
  base: string;
  /** Frozen once the pull request is closed or merged; live tips while open. */
  headSha: string | null;
  baseSha: string | null;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  draft: boolean;
}

export interface Issue {
  id: number;
  repo: Repo;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: Label[];
  comments: Comment[];
  created: number;
  updated: number;
  closed: number | null;
  pull: PullData | null;
  /** Cached REST JSON of this issue (cleared on any change). */
  json: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  created: number;
  updated: number;
  pushed: number | null;
  issues: Map<number, Issue>;
  nextNumber: number;
  labels: Map<string, Label>;
  /** Bumped on every ref change: git response caches key on it. */
  version: number;
  cache: Map<string, Buffer>;
  json: string | null;
}

export const objects = new ObjectStore();
const repos = new Map<string, Repo>();
const reposById = new Map<number, Repo>();
const issuesById = new Map<number, Issue>();
const commentsById = new Map<number, Comment>();

function key(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(key(owner, name));
}

export function getRepo(owner: string, name: string): Repo {
  const repo = repos.get(key(owner, name));
  if (repo === undefined) throw new ApiError(404, 'Not Found');
  return repo;
}

export function repoById(id: number): Repo | undefined {
  return reposById.get(id);
}

export function issueById(id: number): Issue | undefined {
  return issuesById.get(id);
}

export function commentById(id: number): Comment | undefined {
  return commentsById.get(id);
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function touchRepo(repo: Repo): void {
  repo.json = null;
  for (const issue of repo.issues.values()) issue.json = null;
}

export function refChanged(repo: Repo): void {
  repo.version += 1;
  repo.cache.clear();
  repo.pushed = tick();
  repo.json = null;
  // Open pull requests report live head/base tips.
  for (const issue of repo.issues.values()) if (issue.pull !== null && issue.state === 'open') issue.json = null;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function createRepo(input: { name?: unknown; description?: unknown; private?: unknown; visibility?: unknown }): Repo {
  const name = input.name;
  if (typeof name !== 'string' || name === '') throw new ApiError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] });
  if (!NAME_RE.test(name) || name.endsWith('.git')) {
    throw new ApiError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }] });
  }
  if (repos.has(key(VIEWER.login, name))) {
    throw new ApiError(422, 'Repository creation failed.', {
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  const now = tick();
  const priv = typeof input.private === 'boolean' ? input.private : input.visibility === 'private';
  const repo: Repo = {
    id: newId(),
    owner: VIEWER.login,
    name,
    description: typeof input.description === 'string' ? input.description : null,
    private: priv,
    defaultBranch: 'main',
    refs: new Map(),
    created: now,
    updated: now,
    pushed: null,
    issues: new Map(),
    nextNumber: 1,
    labels: new Map(),
    version: 0,
    cache: new Map(),
    json: null,
  };
  repos.set(key(repo.owner, name), repo);
  reposById.set(repo.id, repo);
  return repo;
}

export function updateRepo(repo: Repo, input: Record<string, unknown>): Repo {
  if (typeof input.description === 'string' || input.description === null) repo.description = input.description as string | null;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (input.visibility === 'private' || input.visibility === 'public') repo.private = input.visibility === 'private';
  if (typeof input.default_branch === 'string' && repo.refs.has(`refs/heads/${input.default_branch}`)) repo.defaultBranch = input.default_branch;
  if (typeof input.name === 'string' && input.name !== repo.name && NAME_RE.test(input.name)) {
    if (repos.has(key(repo.owner, input.name))) throw new ApiError(422, 'Repository update failed: name already exists on this account');
    repos.delete(key(repo.owner, repo.name));
    repo.name = input.name;
    repos.set(key(repo.owner, repo.name), repo);
  }
  repo.updated = tick();
  touchRepo(repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(key(repo.owner, repo.name));
  reposById.delete(repo.id);
  for (const issue of repo.issues.values()) {
    issuesById.delete(issue.id);
    for (const c of issue.comments) commentsById.delete(c.id);
  }
}

// ------------------------------------------------------------------ refs and commits

export function branchSha(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Resolve a ref name, branch, tag or commit sha to a commit id (null when nothing matches). */
export function resolveRef(repo: Repo, ref: string | undefined | null): string | null {
  const name = ref === undefined || ref === null || ref === '' ? repo.defaultBranch : ref;
  const direct = repo.refs.get(name) ?? repo.refs.get(`refs/heads/${name}`) ?? repo.refs.get(`refs/tags/${name}`);
  if (direct !== undefined) return objects.peelToCommit(direct);
  if (/^[0-9a-f]{40}$/.test(name) && objects.commit(name) !== null) return name;
  return null;
}

export function setRef(repo: Repo, ref: string, sha: string | null): void {
  if (sha === null) repo.refs.delete(ref);
  else repo.refs.set(ref, sha);
  const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/'));
  if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`) && branches.length === 1 && sha !== null && ref.startsWith('refs/heads/')) {
    repo.defaultBranch = ref.slice(11);
  }
  refChanged(repo);
}

export function treeOf(commit: string | null): FlatTree {
  if (commit === null) return new Map();
  const info = objects.commit(commit);
  return info === null ? new Map() : flattenTree(objects, info.tree);
}

export function makeCommit(tree: string, parents: string[], message: string, time: number): string {
  return objects.put('commit', buildCommit(tree, parents, VIEWER_IDENT, time, message));
}

export interface FileChange {
  path: string;
  /** New content, or null to delete. */
  content: Buffer | null;
}

/** One commit on `branch` changing files (the contents API); creates the branch on an empty repository. */
export function commitFiles(repo: Repo, branch: string, changes: FileChange[], message: string): { commit: string; blobs: Map<string, string> } {
  const parent = branchSha(repo, branch) ?? null;
  const flat = treeOf(parent);
  const blobs = new Map<string, string>();
  for (const change of changes) {
    if (change.content === null) flat.delete(change.path);
    else {
      const oid = objects.put('blob', change.content);
      blobs.set(change.path, oid);
      flat.set(change.path, { mode: '100644', oid });
    }
  }
  const tree = writeFlatTree(objects, flat);
  const commit = makeCommit(tree, parent === null ? [] : [parent], message, tick());
  setRef(repo, `refs/heads/${branch}`, commit);
  return { commit, blobs };
}

// ------------------------------------------------------------------ labels, issues, comments

export function createLabel(repo: Repo, input: Record<string, unknown>): Label {
  const name = input.name;
  if (typeof name !== 'string' || name.trim() === '') throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] });
  if (repo.labels.has(name.toLowerCase())) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
  const color = typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed';
  const label: Label = { id: newId(), name, color, description: typeof input.description === 'string' ? input.description : null };
  repo.labels.set(name.toLowerCase(), label);
  tick();
  return label;
}

function resolveLabels(repo: Repo, value: unknown): Label[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiError(422, 'Validation Failed: labels must be an array');
  const out: Label[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? (item as { name?: unknown }).name : undefined;
    const label = typeof name === 'string' ? repo.labels.get(name.toLowerCase()) : undefined;
    if (label === undefined) {
      throw new ApiError(422, `Validation Failed: the label ${JSON.stringify(name)} does not exist`, {
        errors: [{ resource: 'Label', code: 'invalid', field: 'labels', value: name ?? null }],
      });
    }
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function newIssue(repo: Repo, title: string, body: string | null, labels: Label[], pull: PullData | null): Issue {
  const now = tick();
  const issue: Issue = {
    id: newId(),
    repo,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    stateReason: null,
    labels,
    comments: [],
    created: now,
    updated: now,
    closed: null,
    pull,
    json: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  issuesById.set(issue.id, issue);
  repo.json = null;
  return issue;
}

export function createIssue(repo: Repo, input: Record<string, unknown>): Issue {
  const title = input.title;
  if (typeof title !== 'string' || title === '') throw new ApiError(422, 'Validation Failed: title is required', { errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
  const labels = resolveLabels(repo, input.labels);
  return newIssue(repo, title, typeof input.body === 'string' ? input.body : null, labels, null);
}

export function getIssue(repo: Repo, number: number): Issue {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new ApiError(404, 'Not Found');
  return issue;
}

export function setIssueState(issue: Issue, state: 'open' | 'closed', reason?: string | null): void {
  if (issue.state === state) return;
  const now = tick();
  issue.state = state;
  issue.updated = now;
  if (state === 'closed') {
    issue.closed = now;
    issue.stateReason = reason ?? 'completed';
    if (issue.pull !== null && !issue.pull.merged) freezePull(issue);
  } else {
    issue.closed = null;
    issue.stateReason = 'reopened';
    if (issue.pull !== null) {
      issue.pull.headSha = null;
      issue.pull.baseSha = null;
    }
  }
  issue.json = null;
  issue.repo.json = null;
}

export function updateIssue(issue: Issue, input: Record<string, unknown>): Issue {
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title === '') throw new ApiError(422, 'Validation Failed: title must be a non-empty string');
    issue.title = input.title;
  }
  if (input.body !== undefined) issue.body = typeof input.body === 'string' ? input.body : null;
  if (input.labels !== undefined) issue.labels = resolveLabels(issue.repo, input.labels);
  if (input.state !== undefined) {
    if (input.state !== 'open' && input.state !== 'closed') throw new ApiError(422, 'Validation Failed: state must be open or closed');
    setIssueState(issue, input.state, typeof input.state_reason === 'string' ? input.state_reason : null);
  }
  issue.updated = tick();
  issue.json = null;
  return issue;
}

export function addComment(issue: Issue, body: unknown): Comment {
  if (typeof body !== 'string' || body === '') throw new ApiError(422, 'Validation Failed: body is required', { errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] });
  const now = tick();
  const comment: Comment = { id: newId(), body, created: now, updated: now, issue };
  issue.comments.push(comment);
  commentsById.set(comment.id, comment);
  issue.updated = now;
  issue.json = null;
  return comment;
}

export function listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string; labels?: string; pulls?: boolean }): Issue[] {
  const state = opts.state ?? 'open';
  let list = [...repo.issues.values()].filter((i) => (opts.pulls === true ? i.pull !== null : i.pull === null));
  if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
  if (opts.labels !== undefined && opts.labels !== '') {
    const wanted = opts.labels.split(',').map((s) => s.trim().toLowerCase());
    list = list.filter((i) => wanted.every((w) => i.labels.some((l) => l.name.toLowerCase() === w)));
  }
  const field = opts.sort === 'updated' ? 'updated' : opts.sort === 'comments' ? 'comments' : 'created';
  const desc = opts.direction !== 'asc';
  list.sort((a, b) => {
    const va = field === 'comments' ? a.comments.length : a[field];
    const vb = field === 'comments' ? b.comments.length : b[field];
    if (va !== vb) return desc ? vb - va : va - vb;
    return desc ? b.number - a.number : a.number - b.number;
  });
  return list;
}

// ------------------------------------------------------------------ pull requests

function stripOwner(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

export function createPull(repo: Repo, input: Record<string, unknown>): Issue {
  const title = input.title;
  const headRaw = input.head;
  const baseRaw = input.base;
  if (typeof title !== 'string' || title === '') throw new ApiError(422, 'Validation Failed: title is required', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }] });
  if (typeof headRaw !== 'string' || headRaw === '') throw new ApiError(422, 'Validation Failed: head is required', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'head' }] });
  const base = typeof baseRaw === 'string' && baseRaw !== '' ? stripOwner(baseRaw) : repo.defaultBranch;
  const head = stripOwner(headRaw);
  const headSha = branchSha(repo, head);
  const baseSha = branchSha(repo, base);
  if (headSha === undefined) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head' }] });
  if (baseSha === undefined) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'base' }] });
  if (head === base) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: 'head and base must be different' }] });
  for (const other of repo.issues.values()) {
    if (other.pull !== null && other.state === 'open' && other.pull.head === head && other.pull.base === base) {
      throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.owner}:${head}.` }] });
    }
  }
  if (isAncestor(objects, headSha, baseSha)) {
    throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }] });
  }
  const pull: PullData = { head, base, headSha: null, baseSha: null, merged: false, mergedAt: null, mergeCommitSha: null, draft: input.draft === true };
  return newIssue(repo, title, typeof input.body === 'string' ? input.body : null, [], pull);
}

export function getPull(repo: Repo, number: number): Issue {
  const issue = repo.issues.get(number);
  if (issue === undefined || issue.pull === null) throw new ApiError(404, 'Not Found');
  return issue;
}

export function pullHeadSha(issue: Issue): string {
  const p = issue.pull as PullData;
  return p.headSha ?? branchSha(issue.repo, p.head) ?? ZERO;
}

export function pullBaseSha(issue: Issue): string {
  const p = issue.pull as PullData;
  return p.baseSha ?? branchSha(issue.repo, p.base) ?? ZERO;
}

function freezePull(issue: Issue): void {
  const p = issue.pull as PullData;
  p.headSha = pullHeadSha(issue);
  p.baseSha = pullBaseSha(issue);
}

/** The three-way merge of a pull request's trees: the merged flat tree, or null on a conflict. */
export function mergeTrees(issue: Issue): FlatTree | null {
  const headSha = pullHeadSha(issue);
  const baseSha = pullBaseSha(issue);
  const mb = mergeBase(objects, baseSha, headSha);
  const ancestor = treeOf(mb);
  const ours = treeOf(baseSha);
  const theirs = treeOf(headSha);
  const out: FlatTree = new Map();
  const paths = new Set<string>([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (a: { mode: string; oid: string } | undefined, b: { mode: string; oid: string } | undefined): boolean =>
    a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
  for (const path of paths) {
    const b = ancestor.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let pick: { mode: string; oid: string } | undefined;
    if (same(o, t)) pick = o;
    else if (same(b, o)) pick = t;
    else if (same(b, t)) pick = o;
    else return null;
    if (pick !== undefined) out.set(path, pick);
  }
  return out;
}

export function isMergeable(issue: Issue): boolean {
  if (issue.pull === null || issue.state !== 'open') return false;
  return mergeTrees(issue) !== null;
}

export function mergePull(issue: Issue, input: { method?: string; title?: string; message?: string; sha?: string }): string {
  const p = issue.pull as PullData;
  if (p.merged) throw new ApiError(405, 'Pull Request is not mergeable: it is already merged');
  if (issue.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable: it is closed');
  const headSha = pullHeadSha(issue);
  const baseSha = pullBaseSha(issue);
  if (input.sha !== undefined && input.sha !== headSha) throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  const merged = mergeTrees(issue);
  if (merged === null) throw new ApiError(405, 'Pull Request is not mergeable');
  const repo = issue.repo;
  const tree = writeFlatTree(objects, merged);
  const method = input.method ?? 'merge';
  const title = input.title ?? (method === 'merge' ? `Merge pull request #${issue.number} from ${repo.owner}/${p.head}` : `${issue.title} (#${issue.number})`);
  const message = input.message !== undefined && input.message !== '' ? `${title}\n\n${input.message}` : title;
  const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];
  const commit = makeCommit(tree, parents, message, tick());
  p.headSha = headSha;
  p.baseSha = baseSha;
  setRef(repo, `refs/heads/${p.base}`, commit);
  const now = tick();
  p.merged = true;
  p.mergedAt = now;
  p.mergeCommitSha = commit;
  issue.state = 'closed';
  issue.closed = now;
  issue.updated = now;
  issue.json = null;
  return commit;
}

/** Ids and timestamps restart from the trial's opening (used only by local tests). */
export function resetClock(): void {
  clockBase = trialEpoch();
  ticks = 0;
}
