// GitHub GraphQL v4 at /api/graphql: a small GraphQL engine (lexer, parser, validator, executor with
// introspection) over a schema covering what gh and github-mcp-server send. Batched bodies (a JSON
// array of operations) answer an array in order. Validation errors are a 200 with an `errors` array.

import { logFrom } from './git.ts';
import {
  ApiError,
  VIEWER,
  addComment,
  branchSha,
  commentById,
  createIssue,
  createPull,
  createRepo,
  decodeNodeId,
  findRepo,
  getRepo,
  isMergeable,
  issueById,
  iso,
  listIssues,
  listRepos,
  mergePull,
  nodeId,
  objects,
  pullBaseSha,
  pullHeadSha,
  repoById,
  setIssueState,
  updateIssue,
  type Comment,
  type Issue,
  type Label,
  type Repo,
} from './store.ts';
import { ORIGIN, pullFiles } from './rest.ts';

// ------------------------------------------------------------------ lexer

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
  value: string;
  line: number;
  col: number;
}

class GqlError extends Error {
  line: number;
  col: number;
  code: string | undefined;
  constructor(message: string, line = 0, col = 0, code?: string) {
    super(message);
    this.line = line;
    this.col = col;
    this.code = code;
  }
}

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i] as string;
    if (ch === '\n') {
      line += 1;
      i += 1;
      lineStart = i;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    const col = i - lineStart + 1;
    if (ch === '.' && src.startsWith('...', i)) {
      out.push({ kind: 'punct', value: '...', line, col });
      i += 3;
      continue;
    }
    if ('!$()&:=@[]{}|'.includes(ch)) {
      out.push({ kind: 'punct', value: ch, line, col });
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j), line, col });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (m === null) throw new GqlError(`Parse error on "${ch}"`, line, col);
      out.push({ kind: m[2] !== undefined || m[3] !== undefined ? 'float' : 'int', value: m[0], line, col });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new GqlError('Unterminated block string', line, col);
        const raw = src.slice(i + 3, end).replace(/\\"""/g, '"""');
        for (const c of raw) if (c === '\n') line += 1;
        out.push({ kind: 'string', value: blockString(raw), line, col });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\n') throw new GqlError('Unterminated string', line, col);
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'u') {
            value += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          value += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : (e ?? '');
          j += 2;
          continue;
        }
        value += src[j];
        j += 1;
      }
      if (j >= n) throw new GqlError('Unterminated string', line, col);
      out.push({ kind: 'string', value, line, col });
      i = j + 1;
      continue;
    }
    throw new GqlError(`Parse error on "${ch}"`, line, col);
  }
  out.push({ kind: 'eof', value: '', line, col: i - lineStart + 1 });
  return out;
}

function blockString(raw: string): string {
  const lines = raw.split('\n');
  let indent = Infinity;
  for (let k = 1; k < lines.length; k += 1) {
    const l = lines[k] as string;
    const m = /^[ \t]*/.exec(l);
    if (m !== null && m[0].length < l.length) indent = Math.min(indent, m[0].length);
  }
  const out = lines.map((l, k) => (k > 0 && indent !== Infinity ? l.slice(indent) : l));
  while (out.length > 0 && (out[0] as string).trim() === '') out.shift();
  while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop();
  return out.join('\n');
}

// ------------------------------------------------------------------ AST and parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int' | 'float' | 'string' | 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: [string, Value][] };

interface Directive {
  name: string;
  args: [string, Value][];
}

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: [string, Value][];
  directives: Directive[];
  selections: Selection[] | null;
  line: number;
  col: number;
}

type Selection =
  | FieldNode
  | { kind: 'spread'; name: string; directives: Directive[]; line: number; col: number }
  | { kind: 'inline'; typeCond: string | null; directives: Directive[]; selections: Selection[] };

interface Operation {
  op: 'query' | 'mutation' | 'subscription';
  name: string | null;
  vars: { name: string; type: string; dflt: Value | null }[];
  selections: Selection[];
}

interface Fragment {
  name: string;
  typeCond: string;
  selections: Selection[];
}

class Parser {
  private t: Token[];
  private i = 0;
  constructor(src: string) {
    this.t = lex(src);
  }
  private peek(): Token {
    return this.t[this.i] as Token;
  }
  private next(): Token {
    return this.t[this.i++] as Token;
  }
  private is(value: string): boolean {
    const tok = this.peek();
    return tok.kind === 'punct' && tok.value === value;
  }
  private expect(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new GqlError(`Parse error on "${tok.value || 'end of document'}" (expected "${value}")`, tok.line, tok.col);
    }
  }
  private name(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new GqlError(`Parse error on "${tok.value || 'end of document'}" (expected a name)`, tok.line, tok.col);
    return tok.value;
  }

  document(): { ops: Operation[]; frags: Map<string, Fragment> } {
    const ops: Operation[] = [];
    const frags = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (this.is('{')) ops.push({ op: 'query', name: null, vars: [], selections: this.selectionSet() });
      else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) ops.push(this.operation());
      else if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.name();
        if (this.name() !== 'on') throw new GqlError('Parse error: expected "on"', tok.line, tok.col);
        const typeCond = this.name();
        this.directives();
        frags.set(name, { name, typeCond, selections: this.selectionSet() });
      } else throw new GqlError(`Parse error on "${tok.value}"`, tok.line, tok.col);
    }
    if (ops.length === 0) throw new GqlError('The document holds no operation');
    return { ops, frags };
  }

  private operation(): Operation {
    const op = this.name() as Operation['op'];
    const name = this.peek().kind === 'name' ? this.name() : null;
    const vars: Operation['vars'] = [];
    if (this.is('(')) {
      this.next();
      while (!this.is(')')) {
        this.expect('$');
        const vname = this.name();
        this.expect(':');
        const type = this.type();
        let dflt: Value | null = null;
        if (this.is('=')) {
          this.next();
          dflt = this.value();
        }
        this.directives();
        vars.push({ name: vname, type, dflt });
      }
      this.next();
    }
    this.directives();
    return { op, name, vars, selections: this.selectionSet() };
  }

  private type(): string {
    let t: string;
    if (this.is('[')) {
      this.next();
      t = `[${this.type()}]`;
      this.expect(']');
    } else t = this.name();
    if (this.is('!')) {
      this.next();
      t += '!';
    }
    return t;
  }

  private directives(): Directive[] {
    const out: Directive[] = [];
    while (this.is('@')) {
      this.next();
      const name = this.name();
      out.push({ name, args: this.is('(') ? this.args() : [] });
    }
    return out;
  }

  private args(): [string, Value][] {
    this.expect('(');
    const out: [string, Value][] = [];
    while (!this.is(')')) {
      const name = this.name();
      this.expect(':');
      out.push([name, this.value()]);
    }
    this.next();
    return out;
  }

  private value(): Value {
    const tok = this.next();
    if (tok.kind === 'punct') {
      if (tok.value === '$') return { kind: 'var', name: this.name() };
      if (tok.value === '[') {
        const values: Value[] = [];
        while (!this.is(']')) values.push(this.value());
        this.next();
        return { kind: 'list', values };
      }
      if (tok.value === '{') {
        const fields: [string, Value][] = [];
        while (!this.is('}')) {
          const name = this.name();
          this.expect(':');
          fields.push([name, this.value()]);
        }
        this.next();
        return { kind: 'object', fields };
      }
    }
    if (tok.kind === 'int' || tok.kind === 'float' || tok.kind === 'string') return { kind: tok.kind, value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true' || tok.value === 'false') return { kind: 'bool', value: tok.value === 'true' };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new GqlError(`Parse error on "${tok.value || 'end of document'}" (expected a value)`, tok.line, tok.col);
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') throw new GqlError('Parse error on end of document (expected "}")');
      out.push(this.selection());
    }
    this.next();
    return out;
  }

  private selection(): Selection {
    if (this.is('...')) {
      const start = this.next();
      const tok = this.peek();
      if (tok.kind === 'name' && tok.value === 'on') {
        this.next();
        const typeCond = this.name();
        const directives = this.directives();
        return { kind: 'inline', typeCond, directives, selections: this.selectionSet() };
      }
      if (tok.kind === 'name') {
        const name = this.name();
        return { kind: 'spread', name, directives: this.directives(), line: start.line, col: start.col };
      }
      const directives = this.directives();
      return { kind: 'inline', typeCond: null, directives, selections: this.selectionSet() };
    }
    const tok = this.peek();
    let name = this.name();
    let alias = name;
    if (this.is(':')) {
      this.next();
      name = this.name();
    }
    const args = this.is('(') ? this.args() : [];
    const directives = this.directives();
    const selections = this.is('{') ? this.selectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selections, line: tok.line, col: tok.col };
  }
}

// ------------------------------------------------------------------ schema model

type Resolver = (parent: any, args: Record<string, any>) => unknown;

interface FieldDef {
  type: string;
  args?: Record<string, string>;
  resolve?: Resolver;
  description?: string;
}

interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  name: string;
  description?: string;
  fields?: Record<string, FieldDef>;
  interfaces?: string[];
  values?: string[];
  inputFields?: Record<string, string>;
  members?: string[];
}

const types = new Map<string, TypeDef>();

function def(t: TypeDef): void {
  types.set(t.name, t);
}

function namedOf(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

// ------------------------------------------------------------------ helpers for resolvers

const USER = { __kind: 'User' };

function cursor(i: number): string {
  return Buffer.from(`cursor:v2:${i}`).toString('base64');
}

function cursorIndex(c: unknown): number {
  if (typeof c !== 'string' || c === '') return -1;
  const m = /^cursor:v2:(\d+)$/.exec(Buffer.from(c, 'base64').toString('utf8'));
  return m === null ? -1 : Number(m[1]);
}

function connection<T>(all: T[], args: Record<string, any>): Record<string, unknown> {
  let start = 0;
  let end = all.length;
  const after = cursorIndex(args.after);
  if (after >= 0) start = after + 1;
  const before = cursorIndex(args.before);
  if (before >= 0) end = Math.min(end, before);
  if (typeof args.first === 'number') end = Math.min(end, start + Math.max(0, args.first));
  if (typeof args.last === 'number') start = Math.max(start, end - Math.max(0, args.last));
  const slice = all.slice(start, end);
  const edges = slice.map((node, k) => ({ node, cursor: cursor(start + k) }));
  return {
    nodes: slice,
    edges,
    totalCount: all.length,
    pageInfo: {
      hasNextPage: end < all.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursor(start) : null,
      endCursor: slice.length > 0 ? cursor(end - 1) : null,
    },
  };
}

interface RefDesc {
  __kind: 'Ref';
  repo: Repo;
  ref: string;
}
interface CommitDesc {
  __kind: 'Commit';
  repo: Repo;
  oid: string;
}

function refDesc(repo: Repo, ref: string): RefDesc | null {
  return repo.refs.has(ref) ? { __kind: 'Ref', repo, ref } : null;
}

function commitDesc(repo: Repo, oid: string | null): CommitDesc | null {
  return oid !== null && objects.commit(oid) !== null ? { __kind: 'Commit', repo, oid } : null;
}

function isRepo(v: any): v is Repo {
  return v !== null && typeof v === 'object' && v.refs instanceof Map;
}

function isIssue(v: any): v is Issue {
  return v !== null && typeof v === 'object' && 'pull' in v && 'number' in v;
}

function typeOfValue(v: any): string {
  if (v === null || typeof v !== 'object') return 'Unknown';
  if (typeof v.__kind === 'string') return v.__kind;
  if (isRepo(v)) return 'Repository';
  if (isIssue(v)) return v.pull === null ? 'Issue' : 'PullRequest';
  if ('issue' in v && 'body' in v) return 'IssueComment';
  if ('color' in v) return 'Label';
  return 'Unknown';
}

function issueState(i: Issue): string {
  if (i.pull !== null) return i.pull.merged ? 'MERGED' : i.state === 'open' ? 'OPEN' : 'CLOSED';
  return i.state === 'open' ? 'OPEN' : 'CLOSED';
}

function stateFilter(states: unknown): string[] | null {
  if (states === undefined || states === null) return null;
  return (Array.isArray(states) ? states : [states]).map((s) => String(s));
}

function issuesOf(repo: Repo, args: Record<string, any>, pulls: boolean): Issue[] {
  const order = args.orderBy as { field?: string; direction?: string } | undefined;
  const field = order?.field === 'UPDATED_AT' ? 'updated' : order?.field === 'COMMENTS' ? 'comments' : 'created';
  let list = listIssues(repo, { state: 'all', sort: field, direction: order?.direction === 'DESC' ? 'desc' : 'asc', pulls });
  const states = stateFilter(args.states ?? args.filterBy?.states);
  if (states !== null) list = list.filter((i) => states.includes(issueState(i)));
  const labels = args.labels ?? args.filterBy?.labels;
  if (Array.isArray(labels) && labels.length > 0) {
    list = list.filter((i) => labels.some((l: unknown) => i.labels.some((x) => x.name.toLowerCase() === String(l).toLowerCase())));
  }
  if (pulls && typeof args.headRefName === 'string') list = list.filter((i) => i.pull?.head === args.headRefName);
  if (pulls && typeof args.baseRefName === 'string') list = list.filter((i) => i.pull?.base === args.baseRefName);
  return list;
}

function repoFromId(id: unknown): Repo {
  const d = typeof id === 'string' ? decodeNodeId(id) : null;
  const repo = d !== null && d.kind === 'Repository' ? repoById(d.id) : undefined;
  if (repo === undefined) throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`, 0, 0, 'NOT_FOUND');
  return repo;
}

function issueFromId(id: unknown): Issue {
  const d = typeof id === 'string' ? decodeNodeId(id) : null;
  const issue = d !== null && (d.kind === 'Issue' || d.kind === 'PullRequest') ? issueById(d.id) : undefined;
  if (issue === undefined) throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`, 0, 0, 'NOT_FOUND');
  return issue;
}

function nodeFromId(id: unknown): unknown {
  const d = typeof id === 'string' ? decodeNodeId(id) : null;
  if (d === null) return null;
  if (d.kind === 'Repository') return repoById(d.id) ?? null;
  if (d.kind === 'Issue' || d.kind === 'PullRequest') return issueById(d.id) ?? null;
  if (d.kind === 'IssueComment') return commentById(d.id) ?? null;
  if (d.kind === 'User' && d.id === VIEWER.id) return USER;
  return null;
}

function labelsByIds(repo: Repo, ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const out: string[] = [];
  for (const id of ids) {
    const d = typeof id === 'string' ? decodeNodeId(id) : null;
    const label = [...repo.labels.values()].find((l) => d !== null && l.id === d.id);
    if (label === undefined) throw new GqlError(`Could not resolve to a Label with the id ${String(id)}`, 0, 0, 'NOT_FOUND');
    out.push(label.name);
  }
  return out;
}

function person(ident: string): Record<string, unknown> {
  const m = /^(.*?) <([^>]*)> (\d+)/.exec(ident);
  return { name: m?.[1] ?? ident, email: m?.[2] ?? '', date: iso(Number(m?.[3] ?? 0)), user: USER };
}

// ------------------------------------------------------------------ the schema

const SCALARS = ['ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime', 'URI', 'GitObjectID', 'HTML', 'GitTimestamp', 'Base64String'];
for (const name of SCALARS) def({ kind: 'SCALAR', name });

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  RepositoryVisibility: ['PRIVATE', 'PUBLIC', 'INTERNAL'],
  SearchType: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  RepositoryOrderField: ['CREATED_AT', 'UPDATED_AT', 'PUSHED_AT', 'NAME', 'STARGAZERS'],
  OrderDirection: ['ASC', 'DESC'],
  PatchStatus: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};
for (const [name, values] of Object.entries(ENUMS)) def({ kind: 'ENUM', name, values });

const INPUTS: Record<string, Record<string, string>> = {
  IssueOrder: { field: 'IssueOrderField!', direction: 'OrderDirection!' },
  IssueFilters: { states: '[IssueState!]', labels: '[String!]', assignee: 'String', createdBy: 'String', since: 'DateTime' },
  RepositoryOrder: { field: 'RepositoryOrderField!', direction: 'OrderDirection!' },
  CreateIssueInput: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', assigneeIds: '[ID!]', milestoneId: 'ID', clientMutationId: 'String' },
  CloseIssueInput: { issueId: 'ID!', stateReason: 'IssueStateReason', clientMutationId: 'String' },
  ReopenIssueInput: { issueId: 'ID!', clientMutationId: 'String' },
  UpdateIssueInput: { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', labelIds: '[ID!]', clientMutationId: 'String' },
  AddCommentInput: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' },
  CreatePullRequestInput: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', maintainerCanModify: 'Boolean', clientMutationId: 'String' },
  MergePullRequestInput: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' },
  ClosePullRequestInput: { pullRequestId: 'ID!', clientMutationId: 'String' },
  UpdatePullRequestInput: { pullRequestId: 'ID!', title: 'String', body: 'String', baseRefName: 'String', state: 'PullRequestUpdateState', clientMutationId: 'String' },
  CreateRepositoryInput: { name: 'String!', description: 'String', visibility: 'RepositoryVisibility!', ownerId: 'ID', clientMutationId: 'String' },
};
for (const [name, inputFields] of Object.entries(INPUTS)) def({ kind: 'INPUT_OBJECT', name, inputFields });
def({ kind: 'ENUM', name: 'PullRequestUpdateState', values: ['OPEN', 'CLOSED'] });

const PAGE_ARGS = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

function connectionType(name: string, node: string): void {
  def({ kind: 'OBJECT', name: `${name}Edge`, fields: { node: { type: node }, cursor: { type: 'String!' } } });
  def({
    kind: 'OBJECT',
    name: `${name}Connection`,
    fields: { nodes: { type: `[${node}]` }, edges: { type: `[${name}Edge]` }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  });
}

def({
  kind: 'OBJECT',
  name: 'PageInfo',
  fields: { hasNextPage: { type: 'Boolean!' }, hasPreviousPage: { type: 'Boolean!' }, startCursor: { type: 'String' }, endCursor: { type: 'String' } },
});
connectionType('Issue', 'Issue');
connectionType('PullRequest', 'PullRequest');
connectionType('Repository', 'Repository');
connectionType('IssueComment', 'IssueComment');
connectionType('Label', 'Label');
connectionType('User', 'User');
connectionType('Ref', 'Ref');
connectionType('PullRequestChangedFile', 'PullRequestChangedFile');
connectionType('PullRequestCommit', 'PullRequestCommit');
connectionType('Commit', 'Commit');

def({ kind: 'INTERFACE', name: 'Node', fields: { id: { type: 'ID!' } } });
def({ kind: 'INTERFACE', name: 'RepositoryOwner', fields: { id: { type: 'ID!' }, login: { type: 'String!' }, url: { type: 'URI!' } } });
def({ kind: 'INTERFACE', name: 'Actor', fields: { login: { type: 'String!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: 'Int' } } } });
def({ kind: 'INTERFACE', name: 'GitObject', fields: { id: { type: 'ID!' }, oid: { type: 'GitObjectID!' }, abbreviatedOid: { type: 'String!' } } });
def({ kind: 'UNION', name: 'IssueOrPullRequest', members: ['Issue', 'PullRequest'] });
def({ kind: 'UNION', name: 'SearchResultItem', members: ['Issue', 'PullRequest', 'Repository', 'User'] });

def({
  kind: 'OBJECT',
  name: 'User',
  interfaces: ['Node', 'RepositoryOwner', 'Actor'],
  fields: {
    id: { type: 'ID!', resolve: () => nodeId('User', VIEWER.id) },
    databaseId: { type: 'Int', resolve: () => VIEWER.id },
    login: { type: 'String!', resolve: () => VIEWER.login },
    name: { type: 'String', resolve: () => VIEWER.name },
    email: { type: 'String!', resolve: () => VIEWER.email },
    url: { type: 'URI!', resolve: () => `${ORIGIN}/${VIEWER.login}` },
    avatarUrl: { type: 'URI!', args: { size: 'Int' }, resolve: () => `${ORIGIN}/avatars/${VIEWER.login}` },
    bio: { type: 'String', resolve: () => null },
    company: { type: 'String', resolve: () => null },
    location: { type: 'String', resolve: () => null },
    createdAt: { type: 'DateTime!', resolve: () => iso(0) },
    repositories: {
      type: 'RepositoryConnection!',
      args: { ...PAGE_ARGS, orderBy: 'RepositoryOrder', privacy: 'RepositoryPrivacy', ownerAffiliations: '[RepositoryAffiliation]' },
      resolve: (_p, a) => connection(listRepos(), a),
    },
    repository: { type: 'Repository', args: { name: 'String!' }, resolve: (_p, a) => findRepo(VIEWER.login, String(a.name)) ?? null },
  },
});

def({
  kind: 'OBJECT',
  name: 'Repository',
  interfaces: ['Node'],
  fields: {
    id: { type: 'ID!', resolve: (r: Repo) => nodeId('Repository', r.id) },
    databaseId: { type: 'Int', resolve: (r: Repo) => r.id },
    name: { type: 'String!' },
    nameWithOwner: { type: 'String!', resolve: (r: Repo) => `${r.owner}/${r.name}` },
    owner: { type: 'RepositoryOwner!', resolve: () => USER },
    description: { type: 'String' },
    url: { type: 'URI!', resolve: (r: Repo) => `${ORIGIN}/${r.owner}/${r.name}` },
    sshUrl: { type: 'String!', resolve: (r: Repo) => `git@forge.local:${r.owner}/${r.name}.git` },
    isPrivate: { type: 'Boolean!', resolve: (r: Repo) => r.private },
    visibility: { type: 'RepositoryVisibility!', resolve: (r: Repo) => (r.private ? 'PRIVATE' : 'PUBLIC') },
    isFork: { type: 'Boolean!', resolve: () => false },
    isArchived: { type: 'Boolean!', resolve: () => false },
    isEmpty: { type: 'Boolean!', resolve: (r: Repo) => r.refs.size === 0 },
    isTemplate: { type: 'Boolean!', resolve: () => false },
    createdAt: { type: 'DateTime!', resolve: (r: Repo) => iso(r.created) },
    updatedAt: { type: 'DateTime!', resolve: (r: Repo) => iso(r.updated) },
    pushedAt: { type: 'DateTime', resolve: (r: Repo) => (r.pushed === null ? null : iso(r.pushed)) },
    stargazerCount: { type: 'Int!', resolve: () => 0 },
    forkCount: { type: 'Int!', resolve: () => 0 },
    hasIssuesEnabled: { type: 'Boolean!', resolve: () => true },
    hasWikiEnabled: { type: 'Boolean!', resolve: () => false },
    hasProjectsEnabled: { type: 'Boolean!', resolve: () => false },
    mergeCommitAllowed: { type: 'Boolean!', resolve: () => true },
    squashMergeAllowed: { type: 'Boolean!', resolve: () => true },
    rebaseMergeAllowed: { type: 'Boolean!', resolve: () => true },
    deleteBranchOnMerge: { type: 'Boolean!', resolve: () => false },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    viewerCanAdminister: { type: 'Boolean!', resolve: () => true },
    viewerHasStarred: { type: 'Boolean!', resolve: () => false },
    defaultBranchRef: { type: 'Ref', resolve: (r: Repo) => refDesc(r, `refs/heads/${r.defaultBranch}`) },
    ref: { type: 'Ref', args: { qualifiedName: 'String!' }, resolve: (r: Repo, a) => {
      const q = String(a.qualifiedName);
      return refDesc(r, q.startsWith('refs/') ? q : `refs/heads/${q}`) ?? refDesc(r, `refs/tags/${q}`);
    } },
    refs: { type: 'RefConnection', args: { ...PAGE_ARGS, refPrefix: 'String!', query: 'String' }, resolve: (r: Repo, a) => {
      const prefix = String(a.refPrefix);
      const names = [...r.refs.keys()].filter((n) => n.startsWith(prefix)).sort();
      return connection(names.map((n) => refDesc(r, n)), a);
    } },
    issue: { type: 'Issue', args: { number: 'Int!' }, resolve: (r: Repo, a) => {
      const i = r.issues.get(Number(a.number));
      return i !== undefined && i.pull === null ? i : null;
    } },
    issues: {
      type: 'IssueConnection!',
      args: { ...PAGE_ARGS, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' },
      resolve: (r: Repo, a) => connection(issuesOf(r, a, false), a),
    },
    pullRequest: { type: 'PullRequest', args: { number: 'Int!' }, resolve: (r: Repo, a) => {
      const i = r.issues.get(Number(a.number));
      return i !== undefined && i.pull !== null ? i : null;
    } },
    pullRequests: {
      type: 'PullRequestConnection!',
      args: { ...PAGE_ARGS, states: '[PullRequestState!]', orderBy: 'IssueOrder', labels: '[String!]', headRefName: 'String', baseRefName: 'String' },
      resolve: (r: Repo, a) => connection(issuesOf(r, a, true), a),
    },
    issueOrPullRequest: { type: 'IssueOrPullRequest', args: { number: 'Int!' }, resolve: (r: Repo, a) => r.issues.get(Number(a.number)) ?? null },
    labels: { type: 'LabelConnection', args: { ...PAGE_ARGS, query: 'String' }, resolve: (r: Repo, a) => connection([...r.labels.values()], a) },
    label: { type: 'Label', args: { name: 'String!' }, resolve: (r: Repo, a) => r.labels.get(String(a.name).toLowerCase()) ?? null },
  },
});

def({
  kind: 'OBJECT',
  name: 'Ref',
  interfaces: ['Node'],
  fields: {
    id: { type: 'ID!', resolve: (d: RefDesc) => Buffer.from(`Ref:${d.repo.id}:${d.ref}`).toString('base64') },
    name: { type: 'String!', resolve: (d: RefDesc) => d.ref.replace(/^refs\/(heads|tags)\//, '') },
    prefix: { type: 'String!', resolve: (d: RefDesc) => (d.ref.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/') },
    target: { type: 'GitObject', resolve: (d: RefDesc) => commitDesc(d.repo, objects.peelToCommit(d.repo.refs.get(d.ref) ?? '')) },
    repository: { type: 'Repository!', resolve: (d: RefDesc) => d.repo },
  },
});

def({
  kind: 'OBJECT',
  name: 'GitActor',
  fields: { name: { type: 'String' }, email: { type: 'String' }, date: { type: 'GitTimestamp' }, user: { type: 'User' } },
});

def({
  kind: 'OBJECT',
  name: 'Commit',
  interfaces: ['Node', 'GitObject'],
  fields: {
    id: { type: 'ID!', resolve: (c: CommitDesc) => Buffer.from(`Commit:${c.oid}`).toString('base64') },
    oid: { type: 'GitObjectID!' },
    abbreviatedOid: { type: 'String!', resolve: (c: CommitDesc) => c.oid.slice(0, 7) },
    message: { type: 'String!', resolve: (c: CommitDesc) => (objects.commit(c.oid)?.message ?? '').replace(/\n$/, '') },
    messageHeadline: { type: 'String!', resolve: (c: CommitDesc) => (objects.commit(c.oid)?.message ?? '').split('\n')[0] },
    messageBody: { type: 'String!', resolve: (c: CommitDesc) => (objects.commit(c.oid)?.message ?? '').split('\n').slice(2).join('\n').replace(/\n$/, '') },
    committedDate: { type: 'DateTime!', resolve: (c: CommitDesc) => iso(objects.commit(c.oid)?.time ?? 0) },
    authoredDate: { type: 'DateTime!', resolve: (c: CommitDesc) => iso(objects.commit(c.oid)?.time ?? 0) },
    url: { type: 'URI!', resolve: (c: CommitDesc) => `${ORIGIN}/${c.repo.owner}/${c.repo.name}/commit/${c.oid}` },
    author: { type: 'GitActor', resolve: (c: CommitDesc) => person(objects.commit(c.oid)?.author ?? '') },
    committer: { type: 'GitActor', resolve: (c: CommitDesc) => person(objects.commit(c.oid)?.committer ?? '') },
    history: { type: 'CommitConnection!', args: PAGE_ARGS, resolve: (c: CommitDesc, a) => connection(logFrom(objects, c.oid, 10_000).map((o) => commitDesc(c.repo, o)), a) },
  },
});

const issueLike: Record<string, FieldDef> = {
  databaseId: { type: 'Int', resolve: (i: Issue) => i.id },
  number: { type: 'Int!' },
  title: { type: 'String!' },
  body: { type: 'String!', resolve: (i: Issue) => i.body ?? '' },
  bodyText: { type: 'String!', resolve: (i: Issue) => i.body ?? '' },
  closed: { type: 'Boolean!', resolve: (i: Issue) => i.state === 'closed' },
  closedAt: { type: 'DateTime', resolve: (i: Issue) => (i.closed === null ? null : iso(i.closed)) },
  createdAt: { type: 'DateTime!', resolve: (i: Issue) => iso(i.created) },
  updatedAt: { type: 'DateTime!', resolve: (i: Issue) => iso(i.updated) },
  author: { type: 'Actor', resolve: () => USER },
  locked: { type: 'Boolean!', resolve: () => false },
  repository: { type: 'Repository!', resolve: (i: Issue) => i.repo },
  labels: { type: 'LabelConnection', args: PAGE_ARGS, resolve: (i: Issue, a) => connection(i.labels, a) },
  comments: { type: 'IssueCommentConnection!', args: PAGE_ARGS, resolve: (i: Issue, a) => connection(i.comments, a) },
  assignees: { type: 'UserConnection!', args: PAGE_ARGS, resolve: (_i: Issue, a) => connection([], a) },
  viewerDidAuthor: { type: 'Boolean!', resolve: () => true },
};

def({
  kind: 'OBJECT',
  name: 'Issue',
  interfaces: ['Node'],
  fields: {
    id: { type: 'ID!', resolve: (i: Issue) => nodeId('Issue', i.id) },
    ...issueLike,
    state: { type: 'IssueState!', resolve: issueState },
    stateReason: { type: 'IssueStateReason', resolve: (i: Issue) => (i.stateReason === null ? null : i.stateReason.toUpperCase().replace(/ /g, '_')) },
    url: { type: 'URI!', resolve: (i: Issue) => `${ORIGIN}/${i.repo.owner}/${i.repo.name}/issues/${i.number}` },
  },
});

def({
  kind: 'OBJECT',
  name: 'PullRequestChangedFile',
  fields: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' }, changeType: { type: 'PatchStatus!' } },
});

def({ kind: 'OBJECT', name: 'PullRequestCommit', interfaces: ['Node'], fields: { id: { type: 'ID!', resolve: (c: CommitDesc) => c.oid }, commit: { type: 'Commit!', resolve: (c: CommitDesc) => c } } });

function changedFiles(i: Issue): Record<string, unknown>[] {
  return pullFiles(i).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED' }));
}

def({
  kind: 'OBJECT',
  name: 'PullRequest',
  interfaces: ['Node'],
  fields: {
    id: { type: 'ID!', resolve: (i: Issue) => nodeId('PullRequest', i.id) },
    ...issueLike,
    state: { type: 'PullRequestState!', resolve: issueState },
    url: { type: 'URI!', resolve: (i: Issue) => `${ORIGIN}/${i.repo.owner}/${i.repo.name}/pull/${i.number}` },
    merged: { type: 'Boolean!', resolve: (i: Issue) => i.pull?.merged === true },
    mergedAt: { type: 'DateTime', resolve: (i: Issue) => (i.pull?.mergedAt == null ? null : iso(i.pull.mergedAt)) },
    mergedBy: { type: 'Actor', resolve: (i: Issue) => (i.pull?.merged === true ? USER : null) },
    isDraft: { type: 'Boolean!', resolve: (i: Issue) => i.pull?.draft === true },
    mergeable: { type: 'MergeableState!', resolve: (i: Issue) => (i.state !== 'open' ? 'UNKNOWN' : isMergeable(i) ? 'MERGEABLE' : 'CONFLICTING') },
    headRefName: { type: 'String!', resolve: (i: Issue) => i.pull?.head },
    baseRefName: { type: 'String!', resolve: (i: Issue) => i.pull?.base },
    headRefOid: { type: 'GitObjectID!', resolve: (i: Issue) => pullHeadSha(i) },
    baseRefOid: { type: 'GitObjectID!', resolve: (i: Issue) => pullBaseSha(i) },
    headRef: { type: 'Ref', resolve: (i: Issue) => refDesc(i.repo, `refs/heads/${i.pull?.head}`) },
    baseRef: { type: 'Ref', resolve: (i: Issue) => refDesc(i.repo, `refs/heads/${i.pull?.base}`) },
    headRepository: { type: 'Repository', resolve: (i: Issue) => i.repo },
    baseRepository: { type: 'Repository', resolve: (i: Issue) => i.repo },
    isCrossRepository: { type: 'Boolean!', resolve: () => false },
    maintainerCanModify: { type: 'Boolean!', resolve: () => false },
    mergeCommit: { type: 'Commit', resolve: (i: Issue) => commitDesc(i.repo, i.pull?.mergeCommitSha ?? null) },
    files: { type: 'PullRequestChangedFileConnection', args: PAGE_ARGS, resolve: (i: Issue, a) => connection(changedFiles(i), a) },
    additions: { type: 'Int!', resolve: (i: Issue) => pullFiles(i).reduce((s, f) => s + f.additions, 0) },
    deletions: { type: 'Int!', resolve: (i: Issue) => pullFiles(i).reduce((s, f) => s + f.deletions, 0) },
    changedFiles: { type: 'Int!', resolve: (i: Issue) => pullFiles(i).length },
    commits: { type: 'PullRequestCommitConnection!', args: PAGE_ARGS, resolve: (i: Issue, a) => {
      const base = new Set(logFrom(objects, pullBaseSha(i), 100_000));
      const shas = logFrom(objects, pullHeadSha(i), 10_000).filter((s) => !base.has(s)).reverse();
      return connection(shas.map((s) => commitDesc(i.repo, s)), a);
    } },
    reviewDecision: { type: 'String', resolve: () => null },
  },
});

def({
  kind: 'OBJECT',
  name: 'IssueComment',
  interfaces: ['Node'],
  fields: {
    id: { type: 'ID!', resolve: (c: Comment) => nodeId('IssueComment', c.id) },
    databaseId: { type: 'Int', resolve: (c: Comment) => c.id },
    body: { type: 'String!' },
    bodyText: { type: 'String!', resolve: (c: Comment) => c.body },
    createdAt: { type: 'DateTime!', resolve: (c: Comment) => iso(c.created) },
    updatedAt: { type: 'DateTime!', resolve: (c: Comment) => iso(c.updated) },
    url: { type: 'URI!', resolve: (c: Comment) => `${ORIGIN}/${c.issue.repo.owner}/${c.issue.repo.name}/issues/${c.issue.number}#issuecomment-${c.id}` },
    author: { type: 'Actor', resolve: () => USER },
    issue: { type: 'Issue!', resolve: (c: Comment) => c.issue },
  },
});

def({
  kind: 'OBJECT',
  name: 'Label',
  interfaces: ['Node'],
  fields: {
    id: { type: 'ID!', resolve: (l: Label) => nodeId('Label', l.id) },
    name: { type: 'String!' },
    color: { type: 'String!' },
    description: { type: 'String' },
  },
});

def({
  kind: 'OBJECT',
  name: 'RateLimit',
  fields: { limit: { type: 'Int!' }, cost: { type: 'Int!' }, remaining: { type: 'Int!' }, used: { type: 'Int!' }, resetAt: { type: 'DateTime!' }, nodeCount: { type: 'Int!' } },
});

def({
  kind: 'OBJECT',
  name: 'SearchResultItemConnection',
  fields: {
    issueCount: { type: 'Int!' },
    repositoryCount: { type: 'Int!' },
    userCount: { type: 'Int!' },
    nodes: { type: '[SearchResultItem]' },
    edges: { type: '[SearchResultItemEdge]' },
    pageInfo: { type: 'PageInfo!' },
  },
});
def({ kind: 'OBJECT', name: 'SearchResultItemEdge', fields: { node: { type: 'SearchResultItem' }, cursor: { type: 'String!' } } });
def({ kind: 'ENUM', name: 'RepositoryPrivacy', values: ['PUBLIC', 'PRIVATE'] });
def({ kind: 'ENUM', name: 'RepositoryAffiliation', values: ['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER'] });

function search(args: Record<string, any>): Record<string, unknown> {
  const query = String(args.query ?? '');
  const type = String(args.type ?? 'ISSUE');
  const terms = query.split(/\s+/).filter(Boolean);
  let repoFilter: Repo[] = listRepos();
  const words: string[] = [];
  let kind: 'issue' | 'pr' | null = null;
  let state: string | null = null;
  for (const t of terms) {
    if (t.startsWith('repo:')) {
      const [o, n] = t.slice(5).split('/');
      const r = findRepo(o ?? '', n ?? '');
      repoFilter = r === undefined ? [] : [r];
    } else if (t === 'is:issue' || t === 'type:issue') kind = 'issue';
    else if (t === 'is:pr' || t === 'type:pr') kind = 'pr';
    else if (t === 'is:open' || t === 'state:open') state = 'open';
    else if (t === 'is:closed' || t === 'state:closed') state = 'closed';
    else if (!t.includes(':')) words.push(t.toLowerCase());
  }
  let items: unknown[];
  if (type === 'REPOSITORY') items = repoFilter.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
  else if (type === 'USER') items = [USER];
  else {
    items = repoFilter
      .flatMap((r) => [...r.issues.values()])
      .filter((i) => (kind === null ? true : kind === 'pr' ? i.pull !== null : i.pull === null))
      .filter((i) => state === null || i.state === state)
      .filter((i) => words.every((w) => `${i.title} ${i.body ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => b.created - a.created || b.id - a.id);
  }
  const conn = connection(items, args);
  return { ...conn, issueCount: type.startsWith('ISSUE') ? items.length : 0, repositoryCount: type === 'REPOSITORY' ? items.length : 0, userCount: type === 'USER' ? items.length : 0 };
}

def({
  kind: 'OBJECT',
  name: 'Query',
  fields: {
    viewer: { type: 'User!', resolve: () => USER },
    repository: { type: 'Repository', args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' }, resolve: (_p, a) => findRepo(String(a.owner), String(a.name)) ?? null },
    repositoryOwner: { type: 'RepositoryOwner', args: { login: 'String!' }, resolve: (_p, a) => (String(a.login).toLowerCase() === VIEWER.login.toLowerCase() ? USER : null) },
    user: { type: 'User', args: { login: 'String!' }, resolve: (_p, a) => (String(a.login).toLowerCase() === VIEWER.login.toLowerCase() ? USER : null) },
    node: { type: 'Node', args: { id: 'ID!' }, resolve: (_p, a) => nodeFromId(a.id) },
    nodes: { type: '[Node]!', args: { ids: '[ID!]!' }, resolve: (_p, a) => (Array.isArray(a.ids) ? a.ids.map(nodeFromId) : []) },
    rateLimit: { type: 'RateLimit', args: { dryRun: 'Boolean' }, resolve: () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: iso(3600), nodeCount: 0 }) },
    search: { type: 'SearchResultItemConnection!', args: { ...PAGE_ARGS, query: 'String!', type: 'SearchType!' }, resolve: (_p, a) => search(a) },
  },
});

const payload = (name: string, fields: Record<string, FieldDef>): void => def({ kind: 'OBJECT', name, fields: { ...fields, clientMutationId: { type: 'String' } } });
payload('CreateIssuePayload', { issue: { type: 'Issue' } });
payload('CloseIssuePayload', { issue: { type: 'Issue' } });
payload('ReopenIssuePayload', { issue: { type: 'Issue' } });
payload('UpdateIssuePayload', { issue: { type: 'Issue' } });
payload('AddCommentPayload', { commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' }, timelineEdge: { type: 'IssueCommentEdge' } });
payload('CreatePullRequestPayload', { pullRequest: { type: 'PullRequest' } });
payload('MergePullRequestPayload', { pullRequest: { type: 'PullRequest' } });
payload('ClosePullRequestPayload', { pullRequest: { type: 'PullRequest' } });
payload('UpdatePullRequestPayload', { pullRequest: { type: 'PullRequest' } });
payload('CreateRepositoryPayload', { repository: { type: 'Repository' } });

function inputOf(a: Record<string, any>): Record<string, any> {
  const input = a.input;
  if (input === null || typeof input !== 'object') throw new GqlError("Argument 'input' on Field is required", 0, 0, 'argumentLiteralsIncompatible');
  return input as Record<string, any>;
}

def({
  kind: 'OBJECT',
  name: 'Mutation',
  fields: {
    createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const repo = repoFromId(input.repositoryId);
      const issue = createIssue(repo, { title: input.title, body: input.body, labels: labelsByIds(repo, input.labelIds) });
      return { issue, clientMutationId: input.clientMutationId ?? null };
    } },
    closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const issue = issueFromId(input.issueId);
      setIssueState(issue, 'closed', typeof input.stateReason === 'string' ? input.stateReason.toLowerCase() : 'completed');
      return { issue, clientMutationId: input.clientMutationId ?? null };
    } },
    reopenIssue: { type: 'ReopenIssuePayload', args: { input: 'ReopenIssueInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const issue = issueFromId(input.issueId);
      setIssueState(issue, 'open');
      return { issue, clientMutationId: input.clientMutationId ?? null };
    } },
    updateIssue: { type: 'UpdateIssuePayload', args: { input: 'UpdateIssueInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const issue = issueFromId(input.id);
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.body !== undefined) patch.body = input.body;
      if (input.state !== undefined) patch.state = String(input.state).toLowerCase();
      if (input.labelIds !== undefined) patch.labels = labelsByIds(issue.repo, input.labelIds);
      updateIssue(issue, patch);
      return { issue, clientMutationId: input.clientMutationId ?? null };
    } },
    addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const issue = issueFromId(input.subjectId);
      const comment = addComment(issue, input.body);
      const edge = { node: comment, cursor: cursor(issue.comments.length - 1) };
      return { commentEdge: edge, timelineEdge: edge, subject: issue, clientMutationId: input.clientMutationId ?? null };
    } },
    createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const repo = repoFromId(input.repositoryId);
      const pull = createPull(repo, { title: input.title, head: input.headRefName, base: input.baseRefName, body: input.body, draft: input.draft });
      return { pullRequest: pull, clientMutationId: input.clientMutationId ?? null };
    } },
    mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const issue = issueFromId(input.pullRequestId);
      if (issue.pull === null) throw new GqlError('That node is not a pull request', 0, 0, 'NOT_FOUND');
      mergePull(issue, {
        method: typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge',
        title: typeof input.commitHeadline === 'string' ? input.commitHeadline : undefined,
        message: typeof input.commitBody === 'string' ? input.commitBody : undefined,
        sha: typeof input.expectedHeadOid === 'string' ? input.expectedHeadOid : undefined,
      });
      return { pullRequest: issue, clientMutationId: input.clientMutationId ?? null };
    } },
    closePullRequest: { type: 'ClosePullRequestPayload', args: { input: 'ClosePullRequestInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const issue = issueFromId(input.pullRequestId);
      setIssueState(issue, 'closed');
      return { pullRequest: issue, clientMutationId: input.clientMutationId ?? null };
    } },
    updatePullRequest: { type: 'UpdatePullRequestPayload', args: { input: 'UpdatePullRequestInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const issue = issueFromId(input.pullRequestId);
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.body !== undefined) patch.body = input.body;
      if (input.state !== undefined) patch.state = String(input.state).toLowerCase();
      updateIssue(issue, patch);
      if (typeof input.baseRefName === 'string' && issue.pull !== null && branchSha(issue.repo, input.baseRefName) !== undefined) issue.pull.base = input.baseRefName;
      return { pullRequest: issue, clientMutationId: input.clientMutationId ?? null };
    } },
    createRepository: { type: 'CreateRepositoryPayload', args: { input: 'CreateRepositoryInput!' }, resolve: (_p, a) => {
      const input = inputOf(a);
      const repository = createRepo({ name: input.name, description: input.description, private: input.visibility !== 'PUBLIC' });
      return { repository, clientMutationId: input.clientMutationId ?? null };
    } },
  },
});

// ------------------------------------------------------------------ introspection

type TypeDesc = { kind: string; name: string | null; def?: TypeDef; ofType?: TypeDesc };

function descOf(ref: string): TypeDesc {
  if (ref.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: descOf(ref.slice(0, -1)) };
  if (ref.startsWith('[')) return { kind: 'LIST', name: null, ofType: descOf(ref.slice(1, -1)) };
  const t = types.get(ref);
  return { kind: t?.kind ?? 'SCALAR', name: ref, def: t };
}

const inputValue = (name: string, type: string): Record<string, unknown> => ({
  name,
  description: null,
  type: descOf(type),
  defaultValue: null,
  isDeprecated: false,
  deprecationReason: null,
});

def({
  kind: 'OBJECT',
  name: '__Type',
  fields: {
    kind: { type: '__TypeKind!' },
    name: { type: 'String' },
    description: { type: 'String', resolve: (t: TypeDesc) => t.def?.description ?? null },
    specifiedByURL: { type: 'String', resolve: () => null },
    fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' }, resolve: (t: TypeDesc) => {
      if (t.def?.fields === undefined) return null;
      return Object.entries(t.def.fields).map(([name, f]) => ({
        name,
        description: f.description ?? null,
        args: Object.entries(f.args ?? {}).map(([n, ty]) => inputValue(n, ty)),
        type: descOf(f.type),
        isDeprecated: false,
        deprecationReason: null,
      }));
    } },
    interfaces: { type: '[__Type!]', resolve: (t: TypeDesc) => (t.def?.kind === 'OBJECT' || t.def?.kind === 'INTERFACE' ? (t.def.interfaces ?? []).map(descOf) : null) },
    possibleTypes: { type: '[__Type!]', resolve: (t: TypeDesc) => {
      if (t.def?.kind === 'UNION') return (t.def.members ?? []).map(descOf);
      if (t.def?.kind === 'INTERFACE') return [...types.values()].filter((x) => x.interfaces?.includes(t.name as string)).map((x) => descOf(x.name));
      return null;
    } },
    enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' }, resolve: (t: TypeDesc) =>
      t.def?.kind === 'ENUM' ? (t.def.values ?? []).map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })) : null },
    inputFields: { type: '[__InputValue!]', args: { includeDeprecated: 'Boolean' }, resolve: (t: TypeDesc) =>
      t.def?.kind === 'INPUT_OBJECT' ? Object.entries(t.def.inputFields ?? {}).map(([n, ty]) => inputValue(n, ty)) : null },
    ofType: { type: '__Type', resolve: (t: TypeDesc) => t.ofType ?? null },
    isOneOf: { type: 'Boolean', resolve: () => false },
  },
});
def({
  kind: 'OBJECT',
  name: '__Field',
  fields: { name: { type: 'String!' }, description: { type: 'String' }, args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' } }, type: { type: '__Type!' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
});
def({
  kind: 'OBJECT',
  name: '__InputValue',
  fields: { name: { type: 'String!' }, description: { type: 'String' }, type: { type: '__Type!' }, defaultValue: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
});
def({
  kind: 'OBJECT',
  name: '__EnumValue',
  fields: { name: { type: 'String!' }, description: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
});
def({
  kind: 'OBJECT',
  name: '__Directive',
  fields: { name: { type: 'String!' }, description: { type: 'String' }, locations: { type: '[String!]!' }, args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' } }, isRepeatable: { type: 'Boolean!' } },
});
def({
  kind: 'OBJECT',
  name: '__Schema',
  fields: {
    description: { type: 'String', resolve: () => null },
    types: { type: '[__Type!]!', resolve: () => [...types.keys()].map(descOf) },
    queryType: { type: '__Type!', resolve: () => descOf('Query') },
    mutationType: { type: '__Type', resolve: () => descOf('Mutation') },
    subscriptionType: { type: '__Type', resolve: () => null },
    directives: { type: '[__Directive!]!', resolve: () => [
      { name: 'include', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [inputValue('if', 'Boolean!')], isRepeatable: false },
      { name: 'skip', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [inputValue('if', 'Boolean!')], isRepeatable: false },
    ] },
  },
});

const META_FIELDS: Record<string, FieldDef> = {
  __type: { type: '__Type', args: { name: 'String!' }, resolve: (_p, a) => (types.has(String(a.name)) ? descOf(String(a.name)) : null) },
  __schema: { type: '__Schema!', resolve: () => ({}) },
};

// ------------------------------------------------------------------ validation and execution

interface Ctx {
  vars: Record<string, unknown>;
  frags: Map<string, Fragment>;
  errors: Record<string, unknown>[];
}

function fieldDef(typeName: string, name: string): FieldDef | undefined {
  if (typeName === 'Query' && name in META_FIELDS) return META_FIELDS[name];
  return types.get(typeName)?.fields?.[name];
}

function implementsType(concrete: string, cond: string): boolean {
  if (concrete === cond) return true;
  const t = types.get(cond);
  if (t?.kind === 'UNION') return (t.members ?? []).includes(concrete);
  return types.get(concrete)?.interfaces?.includes(cond) === true;
}

function validate(typeName: string, sels: Selection[], ctx: Ctx, seen: Set<string>, out: GqlError[]): void {
  const t = types.get(typeName);
  for (const s of sels) {
    if (s.kind === 'field') {
      if (s.name === '__typename') continue;
      const f = t?.kind === 'UNION' ? undefined : fieldDef(typeName, s.name);
      if (f === undefined) {
        out.push(new GqlError(`Field '${s.name}' doesn't exist on type '${typeName}'`, s.line, s.col, 'undefinedField'));
        continue;
      }
      const inner = namedOf(f.type);
      const innerDef = types.get(inner);
      const composite = innerDef !== undefined && (innerDef.kind === 'OBJECT' || innerDef.kind === 'INTERFACE' || innerDef.kind === 'UNION');
      if (composite && s.selections === null) out.push(new GqlError(`Field must have selections (field '${s.name}' returns ${inner} but has no selections. Did you mean '${s.name} { ... }'?)`, s.line, s.col, 'selectionMismatch'));
      else if (!composite && s.selections !== null) out.push(new GqlError(`Selections can't be made on scalars (field '${s.name}' returns ${inner} but has selections [${s.selections.map((x) => (x.kind === 'field' ? x.name : '...')).join(', ')}])`, s.line, s.col, 'selectionMismatch'));
      else if (composite && s.selections !== null) validate(inner, s.selections, ctx, seen, out);
    } else if (s.kind === 'inline') {
      const cond = s.typeCond ?? typeName;
      if (!types.has(cond)) out.push(new GqlError(`No such type ${cond}, so it can't be a fragment condition`, 0, 0, 'undefinedType'));
      else validate(cond, s.selections, ctx, seen, out);
    } else {
      const frag = ctx.frags.get(s.name);
      if (frag === undefined) out.push(new GqlError(`Fragment ${s.name} was used, but not defined`, s.line, s.col, 'useAndDefineFragment'));
      else if (!seen.has(s.name)) {
        seen.add(s.name);
        validate(frag.typeCond, frag.selections, ctx, seen, out);
      }
    }
  }
}

function valueOf(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return vars[v.name] ?? null;
    case 'int':
      return Number.parseInt(v.value, 10);
    case 'float':
      return Number(v.value);
    case 'string':
    case 'enum':
      return v.value;
    case 'bool':
      return v.value;
    case 'null':
      return null;
    case 'list':
      return v.values.map((x) => valueOf(x, vars));
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const [k, x] of v.fields) o[k] = valueOf(x, vars);
      return o;
    }
  }
}

function included(directives: Directive[], ctx: Ctx): boolean {
  for (const d of directives) {
    const arg = d.args.find(([n]) => n === 'if');
    const value = arg === undefined ? undefined : valueOf(arg[1], ctx.vars);
    if (d.name === 'skip' && value === true) return false;
    if (d.name === 'include' && value === false) return false;
  }
  return true;
}

function collect(typeName: string, sels: Selection[], ctx: Ctx, out: Map<string, FieldNode[]>): void {
  for (const s of sels) {
    if (!included(s.directives, ctx)) continue;
    if (s.kind === 'field') {
      const list = out.get(s.alias);
      if (list === undefined) out.set(s.alias, [s]);
      else list.push(s);
    } else if (s.kind === 'inline') {
      if (s.typeCond === null || implementsType(typeName, s.typeCond)) collect(typeName, s.selections, ctx, out);
    } else {
      const frag = ctx.frags.get(s.name);
      if (frag !== undefined && implementsType(typeName, frag.typeCond)) collect(typeName, frag.selections, ctx, out);
    }
  }
}

function errorEntry(err: unknown, path: (string | number)[], line: number, col: number): Record<string, unknown> {
  if (err instanceof ApiError) {
    const type = err.status === 404 ? 'NOT_FOUND' : err.status === 422 || err.status === 405 || err.status === 409 ? 'UNPROCESSABLE' : 'INTERNAL';
    const detail = Array.isArray(err.extra?.errors) ? (err.extra.errors as { message?: string }[]).map((e) => e.message).filter(Boolean).join('; ') : '';
    return { type, path, locations: [{ line, column: col }], message: detail !== '' ? `${err.message}: ${detail}` : err.message };
  }
  if (err instanceof GqlError) return { type: err.code ?? 'UNPROCESSABLE', path, locations: [{ line, column: col }], message: err.message };
  return { type: 'INTERNAL', path, locations: [{ line, column: col }], message: err instanceof Error ? err.message : String(err) };
}

function execSelections(typeName: string, value: unknown, sels: Selection[], ctx: Ctx, path: (string | number)[]): Record<string, unknown> {
  const fields = new Map<string, FieldNode[]>();
  collect(typeName, sels, ctx, fields);
  const out: Record<string, unknown> = {};
  for (const [alias, nodes] of fields) {
    const node = nodes[0] as FieldNode;
    if (node.name === '__typename') {
      out[alias] = typeName;
      continue;
    }
    const f = fieldDef(typeName, node.name);
    if (f === undefined) {
      out[alias] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of node.args) args[k] = valueOf(v, ctx.vars);
    const fieldPath = [...path, alias];
    let raw: unknown;
    try {
      raw = f.resolve !== undefined ? f.resolve(value, args) : (value as Record<string, unknown>)[node.name];
    } catch (err) {
      ctx.errors.push(errorEntry(err, fieldPath, node.line, node.col));
      out[alias] = null;
      continue;
    }
    const subs = nodes.length === 1 ? node.selections : nodes.flatMap((x) => x.selections ?? []);
    out[alias] = complete(f.type, raw, subs, ctx, fieldPath);
  }
  return out;
}

function complete(type: string, value: unknown, sels: Selection[] | null, ctx: Ctx, path: (string | number)[]): unknown {
  if (type.endsWith('!')) return complete(type.slice(0, -1), value, sels, ctx, path);
  if (value === null || value === undefined) return null;
  if (type.startsWith('[')) {
    if (!Array.isArray(value)) return null;
    const inner = type.slice(1, -1);
    return value.map((v, i) => complete(inner, v, sels, ctx, [...path, i]));
  }
  const t = types.get(type);
  if (t === undefined || t.kind === 'SCALAR' || t.kind === 'ENUM') return value;
  const concrete = t.kind === 'OBJECT' ? type : typeOfValue(value);
  return execSelections(concrete, value, sels ?? [], ctx, path);
}

interface GqlRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOne(request: GqlRequest): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || typeof request.query !== 'string') {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  let doc: { ops: Operation[]; frags: Map<string, Fragment> };
  try {
    doc = new Parser(request.query).document();
  } catch (err) {
    const e = err as GqlError;
    return { errors: [{ message: e.message, locations: [{ line: e.line, column: e.col }] }] };
  }
  const opName = typeof request.operationName === 'string' && request.operationName !== '' ? request.operationName : null;
  const op = opName === null ? (doc.ops.length === 1 ? doc.ops[0] : undefined) : doc.ops.find((o) => o.name === opName);
  if (op === undefined) return { errors: [{ message: opName === null ? 'An operation name is required' : `No operation named "${opName}"` }] };
  const given = request.variables !== null && typeof request.variables === 'object' ? (request.variables as Record<string, unknown>) : {};
  const vars: Record<string, unknown> = {};
  for (const v of op.vars) {
    if (v.name in given) vars[v.name] = given[v.name];
    else if (v.dflt !== null) vars[v.name] = valueOf(v.dflt, {});
    else if (v.type.endsWith('!')) return { errors: [{ message: `Variable $${v.name} of type ${v.type} was provided invalid value`, extensions: { code: 'variableMismatch' } }] };
    else vars[v.name] = null;
  }
  const ctx: Ctx = { vars, frags: doc.frags, errors: [] };
  const root = op.op === 'mutation' ? 'Mutation' : 'Query';
  const invalid: GqlError[] = [];
  validate(root, op.selections, ctx, new Set(), invalid);
  if (invalid.length > 0) {
    return { errors: invalid.map((e) => ({ path: [op.op === 'mutation' ? 'mutation' : 'query', ...(op.name !== null ? [op.name] : [])], extensions: { code: e.code }, locations: [{ line: e.line, column: e.col }], message: e.message })) };
  }
  const data = execSelections(root, {}, op.selections, ctx, []);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export function handleGraphQL(raw: Buffer): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ message: 'Problems parsing JSON' }) };
  }
  if (Array.isArray(parsed)) return { status: 200, body: JSON.stringify(parsed.map((r) => runOne(r as GqlRequest))) };
  return { status: 200, body: JSON.stringify(runOne(parsed as GqlRequest)) };
}

/** Exposed for the MCP layer's repository lookups. */
export { getRepo };
