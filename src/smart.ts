// Git smart HTTP for one repository: the info/refs advertisements, upload-pack (protocol v2's ls-refs
// and fetch, with the v0 want/have exchange as a fallback) and receive-pack v0 with report-status over
// side-band-64k. Fetch and ls-refs answers are cached per repository version and request body, so
// concurrent identical clones share one pack.

import { DELIM, FLUSH, ZERO, isAncestor, isOid, parseTag, pkt, readPackets, sideband, unpack, writePack } from './git.ts';
import { objects, setRef, type Repo } from './store.ts';

const AGENT = 'agent=forge-griffin/1.0';
const UPLOAD_CAPS = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want ${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k quiet ofs-delta ${AGENT}`;

const V2_ADVERTISEMENT = Buffer.concat([
  pkt('version 2\n'),
  pkt(`${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('server-option\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeled(oid: string): string | null {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  return objects.peelToCommit(oid);
}

export function advertisement(repo: Repo, service: string, v2: boolean): Buffer {
  if (service === 'git-upload-pack' && v2) return V2_ADVERTISEMENT;
  const cacheKey = `adv:${service}`;
  const hit = repo.cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const head = repo.refs.get(headRef);
  if (service === 'git-upload-pack' && head !== undefined) lines.push(`${head} HEAD`);
  for (const [name, oid] of sortedRefs(repo)) {
    lines.push(`${oid} ${name}`);
    if (service === 'git-upload-pack') {
      const p = peeled(oid);
      if (p !== null) lines.push(`${p} ${name}^{}`);
    }
  }
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:${headRef}` : RECEIVE_CAPS;
  if (lines.length === 0) lines.push(`${ZERO} capabilities^{}`);
  lines.forEach((line, i) => parts.push(pkt(i === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.cache.set(cacheKey, out);
  return out;
}

// ------------------------------------------------------------------ object selection

interface FetchPlan {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(wantsIn: string[], haves: string[], clientShallow: Set<string>, depth: number | null): FetchPlan {
  // Everything the client already holds: reachable from its haves, not past its shallow boundary.
  const had = new Set<string>();
  const stack: string[] = haves.filter((h) => objects.has(h));
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (had.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    had.add(oid);
    if (obj.type === 'commit') {
      const c = objects.commit(oid);
      if (c === null) continue;
      stack.push(c.tree);
      if (!clientShallow.has(oid)) stack.push(...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of objects.tree(oid) ?? []) if (e.mode !== '160000') stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }

  const send: string[] = [];
  const sent = new Set<string>();
  const add = (oid: string): void => {
    if (!sent.has(oid) && !had.has(oid)) {
      sent.add(oid);
      send.push(oid);
    }
  };
  const wantCommits: string[] = [];
  for (const want of wantsIn) {
    let cur = want;
    for (let i = 0; i < 10; i += 1) {
      const obj = objects.get(cur);
      if (obj === undefined) break;
      if (obj.type === 'tag') {
        add(cur);
        cur = parseTag(obj.data).object;
        continue;
      }
      if (obj.type === 'commit') wantCommits.push(cur);
      else add(cur);
      break;
    }
  }

  const commits: string[] = [];
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null && depth > 0) {
    const level = new Map<string, number>();
    const queue: string[] = [];
    for (const c of wantCommits) {
      if (!level.has(c)) {
        level.set(c, 1);
        queue.push(c);
      }
    }
    for (let i = 0; i < queue.length; i += 1) {
      const oid = queue[i] as string;
      const d = level.get(oid) as number;
      const info = objects.commit(oid);
      if (info === null) continue;
      commits.push(oid);
      if (d >= depth) {
        if (info.parents.length > 0) shallow.push(oid);
        continue;
      }
      if (clientShallow.has(oid) && info.parents.length > 0) unshallow.push(oid);
      for (const p of info.parents) {
        if (!level.has(p)) {
          level.set(p, d + 1);
          queue.push(p);
        }
      }
    }
  } else {
    const seen = new Set<string>();
    const st = [...wantCommits];
    while (st.length > 0) {
      const oid = st.pop() as string;
      if (seen.has(oid) || had.has(oid)) continue;
      seen.add(oid);
      const info = objects.commit(oid);
      if (info === null) continue;
      commits.push(oid);
      st.push(...info.parents);
    }
  }

  for (const c of commits) add(c);
  for (const c of commits) {
    if (had.has(c)) continue;
    const info = objects.commit(c);
    if (info === null) continue;
    const trees = [info.tree];
    while (trees.length > 0) {
      const t = trees.pop() as string;
      if (sent.has(t) || had.has(t)) continue;
      add(t);
      for (const e of objects.tree(t) ?? []) {
        if (e.mode === '40000') trees.push(e.oid);
        else if (e.mode !== '160000') add(e.oid);
      }
    }
  }
  return { oids: send, shallow, unshallow };
}

function packSection(oids: string[], out: Buffer[]): void {
  sideband(1, writePack(objects, oids), out);
}

// ------------------------------------------------------------------ upload-pack v2

function lsRefs(repo: Repo, args: string[]): Buffer {
  const symrefs = args.includes('symrefs');
  const peel = args.includes('peel');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const head = repo.refs.get(headRef);
  if (keep('HEAD')) {
    if (head !== undefined) out.push(pkt(`${head} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    else if (unborn) out.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const p = peeled(oid);
      if (p !== null) line += ` peeled:${p}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchV2(args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) clientShallow.add(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = Number(a.slice(7));
    else if (a === 'done') done = true;
  }
  for (const w of wants) if (!isOid(w) || !objects.has(w)) throw new Error(`not our ref ${w}`);
  const out: Buffer[] = [];
  if (!done) {
    const common = haves.filter((h) => objects.has(h));
    out.push(pkt('acknowledgments\n'));
    if (common.length === 0) out.push(pkt('NAK\n'));
    for (const c of common) out.push(pkt(`ACK ${c}\n`));
    out.push(pkt('ready\n'), DELIM);
  }
  const plan = planFetch(wants, haves, clientShallow, depth);
  if (depth !== null || clientShallow.size > 0) {
    const lines = [...plan.shallow.map((s) => `shallow ${s}\n`), ...plan.unshallow.map((s) => `unshallow ${s}\n`)];
    if (lines.length > 0 || depth !== null) {
      out.push(pkt('shallow-info\n'));
      for (const l of lines) out.push(pkt(l));
      out.push(DELIM);
    }
  }
  out.push(pkt('packfile\n'));
  packSection(plan.oids, out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const cacheKey = `v2:${body.toString('latin1')}`;
  const hit = repo.cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const { packets } = readPackets(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') inArgs = true;
    else if (p.kind === 'flush') break;
    else if (p.kind === 'data') {
      const line = p.data.toString('utf8').replace(/\n$/, '');
      if (!inArgs) {
        if (line.startsWith('command=')) command = line.slice(8);
      } else args.push(line);
    }
  }
  let out: Buffer;
  if (command === 'ls-refs') out = lsRefs(repo, args);
  else if (command === 'fetch') out = fetchV2(args);
  else throw new Error(`unknown command ${JSON.stringify(command)}`);
  if (repo.cache.size > 256) repo.cache.clear();
  repo.cache.set(cacheKey, out);
  return out;
}

// ------------------------------------------------------------------ upload-pack v0

function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = readPackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let caps = new Set<string>();
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const parts = line.slice(5).split(' ');
      wants.push(parts[0] as string);
      if (wants.length === 1) caps = new Set(parts.slice(1));
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
  }
  for (const w of wants) if (!isOid(w) || !objects.has(w)) throw new Error(`not our ref ${w}`);
  const out: Buffer[] = [];
  const plan = planFetch(wants, haves, clientShallow, depth);
  if (depth !== null) {
    for (const s of plan.shallow) out.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) out.push(pkt(`unshallow ${s}\n`));
    out.push(FLUSH);
  }
  const common = haves.filter((h) => objects.has(h));
  out.push(pkt(common.length > 0 ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  const packBuf = writePack(objects, plan.oids);
  if (caps.has('side-band-64k') || caps.has('side-band')) {
    sideband(1, packBuf, out);
    out.push(FLUSH);
  } else out.push(packBuf);
  return Buffer.concat(out);
}

export function uploadPack(repo: Repo, body: Buffer, v2: boolean): Buffer {
  return v2 ? uploadPackV2(repo, body) : uploadPackV0(repo, body);
}

// ------------------------------------------------------------------ receive-pack

interface Command {
  old: string;
  new: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = readPackets(body, 1);
  const commands: Command[] = [];
  let caps = new Set<string>();
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
      line = line.slice(0, nul);
    }
    const [old, nw, ref] = line.split(' ');
    if (old !== undefined && nw !== undefined && ref !== undefined) commands.push({ old, new: nw, ref });
  }
  let unpackStatus = 'ok';
  const packData = body.subarray(rest);
  if (packData.length > 0) {
    try {
      unpack(objects, packData);
    } catch (err) {
      unpackStatus = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');
    }
  }
  const report: string[] = [`unpack ${unpackStatus}\n`];
  let changed = false;
  for (const cmd of commands) {
    const reason = unpackStatus !== 'ok' ? 'unpacker error' : applyCommand(repo, cmd);
    if (reason === null) {
      report.push(`ok ${cmd.ref}\n`);
      changed = true;
    } else report.push(`ng ${cmd.ref} ${reason}\n`);
  }
  if (changed) repo.cache.clear();
  const inner = Buffer.concat([...report.map((l) => pkt(l)), FLUSH]);
  if (!caps.has('side-band-64k') && !caps.has('side-band')) return caps.has('report-status') || caps.has('report-status-v2') ? inner : Buffer.alloc(0);
  if (!caps.has('report-status') && !caps.has('report-status-v2')) return FLUSH;
  const out: Buffer[] = [];
  sideband(1, inner, out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

function applyCommand(repo: Repo, cmd: Command): string | null {
  if (!cmd.ref.startsWith('refs/') || cmd.ref.includes('..') || !isOid(cmd.old) || !isOid(cmd.new)) return 'funny refname';
  const current = repo.refs.get(cmd.ref);
  if (cmd.new === ZERO) {
    if (current !== undefined && cmd.old !== ZERO && cmd.old !== current) return 'stale info';
    if (current !== undefined) setRef(repo, cmd.ref, null);
    return null;
  }
  if (!objects.has(cmd.new)) return 'missing necessary objects';
  if (current === undefined) {
    if (cmd.old !== ZERO) return 'stale info';
    setRef(repo, cmd.ref, cmd.new);
    return null;
  }
  if (cmd.old !== current) return cmd.old === ZERO ? 'already exists' : 'stale info';
  if (current === cmd.new) return null;
  if (cmd.ref.startsWith('refs/tags/')) return 'already exists';
  const oldCommit = objects.peelToCommit(current);
  const newCommit = objects.peelToCommit(cmd.new);
  if (oldCommit === null || newCommit === null || !isAncestor(objects, oldCommit, newCommit)) return 'non-fast-forward';
  setRef(repo, cmd.ref, cmd.new);
  return null;
}
