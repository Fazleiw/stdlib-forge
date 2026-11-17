// Git's object model and wire primitives, written for this forge: SHA-1 object ids, commit/tree/tag
// parsing, a content-addressed store with parse caches, packfile reading (OFS/REF deltas) and writing,
// and pkt-line framing. Everything is synchronous and Buffer-based; nothing here touches HTTP.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
  /** Deflated data, filled the first time a pack carries this object. */
  z?: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Committer time, seconds. */
  time: number;
}

export const ZERO = '0000000000000000000000000000000000000000';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

// ------------------------------------------------------------------ the store

/** One process-wide object store: objects are content-addressed, so repositories share it. */
export class ObjectStore {
  readonly objects = new Map<string, GitObj>();
  private readonly commits = new Map<string, CommitInfo>();
  private readonly trees = new Map<string, TreeEntry[]>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  put(type: ObjType, data: Buffer, oid?: string): string {
    const id = oid ?? hashObject(type, data);
    if (!this.objects.has(id)) this.objects.set(id, { type, data });
    return id;
  }

  commit(oid: string): CommitInfo | null {
    let info = this.commits.get(oid);
    if (info !== undefined) return info;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    info = parseCommit(obj.data);
    this.commits.set(oid, info);
    return info;
  }

  tree(oid: string): TreeEntry[] | null {
    let entries = this.trees.get(oid);
    if (entries !== undefined) return entries;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return null;
    entries = parseTree(obj.data);
    this.trees.set(oid, entries);
    return entries;
  }

  /** The commit a ref value names, peeling annotated tags. */
  peelToCommit(oid: string): string | null {
    let cur = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = this.objects.get(cur);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type !== 'tag') return null;
      cur = parseTag(obj.data).object;
    }
    return null;
  }

  zdata(obj: GitObj): Buffer {
    if (obj.z === undefined) obj.z = deflateSync(obj.data, { level: 1 });
    return obj.z;
  }
}

// ------------------------------------------------------------------ parsing and building

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree');
    out.push({ mode: data.toString('latin1', i, sp), name: data.toString('utf8', sp + 1, nul), oid: data.toString('hex', nul + 1, nul + 21) });
    i = nul + 21;
  }
  return out;
}

function treeSortKey(e: TreeEntry): Buffer {
  return Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message, time: 0 };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'tree') info.tree = value;
    else if (key === 'parent') info.parents.push(value);
    else if (key === 'author') info.author = value;
    else if (key === 'committer') info.committer = value;
  }
  const m = /(\d+) [+-]\d{4}$/.exec(info.committer);
  info.time = m === null ? 0 : Number(m[1]);
  return info;
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const out = { object: '', type: '', tag: '' };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7);
    else if (line.startsWith('type ')) out.type = line.slice(5);
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
  }
  return out;
}

/** "Name <email> 1700000000 +0000" split into its parts. */
export function parseIdent(ident: string): { name: string; email: string; time: number } {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (m === null) return { name: ident, email: '', time: 0 };
  return { name: m[1] ?? '', email: m[2] ?? '', time: Number(m[3]) };
}

export function buildCommit(tree: string, parents: readonly string[], ident: string, time: number, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident} ${time} +0000`, `committer ${ident} ${time} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
}

// ------------------------------------------------------------------ flat trees (contents API, merges)

export type FlatTree = Map<string, { mode: string; oid: string }>;

export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out: FlatTree = new Map()): FlatTree {
  const entries = store.tree(treeOid);
  if (entries === null) return out;
  for (const e of entries) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(store, e.oid, path, out);
    else out.set(path, { mode: e.mode, oid: e.oid });
  }
  return out;
}

/** Write the nested trees for a flat path map and answer the root tree's id. */
export function writeFlatTree(store: ObjectStore, flat: FlatTree): string {
  interface Dir { files: TreeEntry[]; dirs: Map<string, Dir> }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i] as string;
      let next = dir.dirs.get(name);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push({ mode: entry.mode, name: parts[parts.length - 1] as string, oid: entry.oid });
  }
  const write = (dir: Dir): string => {
    const entries = [...dir.files];
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    return store.put('tree', buildTree(entries));
  };
  return write(root);
}

// ------------------------------------------------------------------ history walks

/** Whether `ancestor` is reachable from `descendant` along parent links (or equal). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    const c = store.commit(oid);
    if (c === null) continue;
    for (const p of c.parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return false;
}

export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const c = store.commit(oid);
    if (c !== null) queue.push(...c.parents);
  }
  const seen = new Set<string>();
  const bfs = [b];
  for (let i = 0; i < bfs.length; i += 1) {
    const oid = bfs[i] as string;
    if (ancestors.has(oid)) return oid;
    const c = store.commit(oid);
    if (c === null) continue;
    for (const p of c.parents) {
      if (!seen.has(p)) {
        seen.add(p);
        bfs.push(p);
      }
    }
  }
  return null;
}

/** Commits reachable from `tip`, newest committer time first (ties keep discovery order). */
export function logFrom(store: ObjectStore, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>([tip]);
  const frontier: string[] = [tip];
  while (frontier.length > 0 && out.length < limit) {
    let best = 0;
    for (let i = 1; i < frontier.length; i += 1) {
      const ti = store.commit(frontier[i] as string)?.time ?? 0;
      const tb = store.commit(frontier[best] as string)?.time ?? 0;
      if (ti > tb) best = i;
    }
    const oid = frontier.splice(best, 1)[0] as string;
    const c = store.commit(oid);
    if (c === null) continue;
    out.push(oid);
    for (const p of c.parents) {
      if (!seen.has(p)) {
        seen.add(p);
        frontier.push(p);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ packfiles

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i++] as number;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if ((b & 0x80) === 0) return v;
    }
  };
  const srcSize = varint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(varint());
  let w = 0;
  while (i < delta.length) {
    const op = delta[i++] as number;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 1) off |= delta[i++] as number;
      if (op & 2) off |= (delta[i++] as number) << 8;
      if (op & 4) off |= (delta[i++] as number) << 16;
      if (op & 8) off += (delta[i++] as number) * 0x1000000;
      if (op & 16) size |= delta[i++] as number;
      if (op & 32) size |= (delta[i++] as number) << 8;
      if (op & 64) size |= (delta[i++] as number) << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, w, off, off + size);
      w += size;
    } else if (op !== 0) {
      delta.copy(out, w, i, i + op);
      i += op;
      w += op;
    } else {
      throw new Error('bad delta opcode');
    }
  }
  if (w !== out.length) throw new Error('delta size mismatch');
  return out;
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const r = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: r.buffer, next: offset + r.engine.bytesWritten };
}

/**
 * Parse a pack and add every object to the store. Thin-pack REF_DELTA bases may come from the store.
 * Answers the ids it stored, in pack order; throws on any corruption.
 */
export function unpack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const sum = createHash('sha1').update(pack.subarray(0, end)).digest();
  if (!sum.equals(pack.subarray(end))) throw new Error('pack checksum mismatch');
  interface Entry { type: ObjType | null; data: Buffer; baseOff?: number; baseOid?: string; oid?: string }
  const byOffset = new Map<number, Entry>();
  const entries: Entry[] = [];
  const body = pack.subarray(0, end);
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const start = off;
    let b = body[off++] as number;
    const code = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      b = body[off++] as number;
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Entry = { type: CODE_TYPE[code] ?? null, data: Buffer.alloc(0) };
    if (code === 6) {
      b = body[off++] as number;
      let rel = b & 0x7f;
      while (b & 0x80) {
        b = body[off++] as number;
        rel = (rel + 1) * 128 + (b & 0x7f);
      }
      entry.baseOff = start - rel;
    } else if (code === 7) {
      entry.baseOid = body.toString('hex', off, off + 20);
      off += 20;
    } else if (entry.type === null) {
      throw new Error(`bad pack type ${code}`);
    }
    const inflated = inflateAt(body, off);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    byOffset.set(start, entry);
    entries.push(entry);
  }
  const resolved = new Map<string, Entry>();
  const resolve = (e: Entry, depth: number): { type: ObjType; data: Buffer } => {
    if (e.oid !== undefined && e.type !== null) return { type: e.type, data: e.data };
    if (depth > 5000) throw new Error('delta chain too deep');
    if (e.baseOff !== undefined || e.baseOid !== undefined) {
      let base: { type: ObjType; data: Buffer } | null = null;
      if (e.baseOff !== undefined) {
        const be = byOffset.get(e.baseOff);
        if (be === undefined) throw new Error('ofs-delta base missing');
        base = resolve(be, depth + 1);
      } else {
        const id = e.baseOid as string;
        const inPack = resolved.get(id);
        if (inPack !== undefined) base = resolve(inPack, depth + 1);
        else {
          const stored = store.get(id);
          if (stored === undefined) throw new Error(`ref-delta base ${id} missing`);
          base = stored;
        }
      }
      e.data = applyDelta(base.data, e.data);
      e.type = base.type;
      e.baseOff = undefined;
      e.baseOid = undefined;
    }
    const type = e.type as ObjType;
    e.oid = hashObject(type, e.data);
    resolved.set(e.oid, e);
    return { type, data: e.data };
  };
  // Plain objects first, so a REF_DELTA may name a base that comes later in the pack.
  for (const e of entries) if (e.baseOff === undefined && e.baseOid === undefined) resolve(e, 0);
  let pending = entries.filter((e) => e.oid === undefined);
  while (pending.length > 0) {
    const before = pending.length;
    for (const e of pending) {
      if (e.baseOid !== undefined && !resolved.has(e.baseOid) && !store.has(e.baseOid)) continue;
      resolve(e, 0);
    }
    pending = pending.filter((e) => e.oid === undefined);
    if (pending.length === before) throw new Error('unresolvable delta base');
  }
  const ids: string[] = [];
  for (const e of entries) {
    ids.push(e.oid as string);
    store.put(e.type as ObjType, e.data, e.oid);
  }
  return ids;
}

function packHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let c = (TYPE_CODE[type] << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(c | 0x80);
    c = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(c);
  return Buffer.from(bytes);
}

/** A version-2 pack of whole objects (no deltas), with its SHA-1 trailer. */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(oids.length, 8);
  parts.push(head);
  for (const oid of oids) {
    const obj = store.get(oid);
    if (obj === undefined) throw new Error(`missing object ${oid}`);
    parts.push(packHeader(obj.type, obj.data.length), store.zdata(obj));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------ pkt-line

const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');
export { FLUSH, DELIM };

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, data]);
}

export type Packet = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode pkt-lines from the front of `buf`; `rest` is the offset where framing stopped (a pack follows). */
export function readPackets(buf: Buffer, stopAfterFlushes = Infinity): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let off = 0;
  let flushes = 0;
  while (off + 4 <= buf.length && flushes < stopAfterFlushes) {
    const hex = buf.toString('latin1', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line header');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      flushes += 1;
      off += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
    } else if (len === 2) {
      packets.push({ kind: 'end' });
      off += 4;
    } else {
      if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return { packets, rest: off };
}

/** Frame `data` as side-band packets on `band`, each within the 65520-byte pkt limit. */
export function sideband(band: number, data: Buffer, out: Buffer[]): void {
  const max = 65515;
  for (let i = 0; i < data.length; i += max) {
    const chunk = data.subarray(i, Math.min(data.length, i + max));
    const head = Buffer.alloc(5);
    head.write((chunk.length + 5).toString(16).padStart(4, '0'), 0, 'latin1');
    head[4] = band;
    out.push(head, chunk);
  }
}
