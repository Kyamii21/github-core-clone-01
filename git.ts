// Git smart HTTP: pkt-line codec, pack reader/writer (plain + deltas),
// protocol v2 upload-pack (advertisement, ls-refs, fetch) and v0
// receive-pack with per-ref fast-forward enforcement.
import { inflateSync, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { Store, type Repo, type ObjType, ZERO, DEFAULT_BRANCH, parseCommit, parseTree, objId } from "./store.ts";

export const AGENT = "github-forge/1.0.0";

// ---- pkt-line ----

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const head = Buffer.from((payload.length + 4).toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, payload]);
}

export const PKT_FLUSH = Buffer.from("0000", "ascii");
export const PKT_DELIM = Buffer.from("0001", "ascii");

export type Packet = { kind: "data"; data: Buffer } | { kind: "flush" } | { kind: "delim" } | { kind: "end" };

export function parsePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer; error?: string } {
  const packets: Packet[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) return { packets, rest: buf.subarray(i), error: "truncated pkt-line header" };
    const hex = buf.subarray(i, i + 4).toString("ascii");
    if (hex === "0000") { packets.push({ kind: "flush" }); i += 4; continue; }
    if (hex === "0001") { packets.push({ kind: "delim" }); i += 4; continue; }
    if (hex === "0002") { packets.push({ kind: "end" }); i += 4; continue; }
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 4 || i + len > buf.length) {
      return { packets, rest: buf.subarray(i), error: `bad pkt-line length ${JSON.stringify(hex)}` };
    }
    packets.push({ kind: "data", data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

// Like parsePktLines, but stops at the first flush packet and returns the
// remaining bytes untouched — a receive-pack body carries a raw packfile
// after its flush, which must never be parsed as pkt-lines.
export function parsePktLinesUntilFlush(buf: Buffer): { packets: Packet[]; rest: Buffer; error?: string } {
  const packets: Packet[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) return { packets, rest: buf.subarray(i), error: "truncated pkt-line header" };
    const hex = buf.subarray(i, i + 4).toString("ascii");
    if (hex === "0000") {
      packets.push({ kind: "flush" });
      return { packets, rest: buf.subarray(i + 4) };
    }
    if (hex === "0001") { packets.push({ kind: "delim" }); i += 4; continue; }
    if (hex === "0002") { packets.push({ kind: "end" }); i += 4; continue; }
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 4 || i + len > buf.length) {
      return { packets, rest: buf.subarray(i), error: `bad pkt-line length ${JSON.stringify(hex)}` };
    }
    packets.push({ kind: "data", data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

function pktLines(items: (string | Buffer | "flush" | "delim")[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === "flush") parts.push(PKT_FLUSH);
    else if (it === "delim") parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

// ---- pack reading ----

interface PackObject {
  type: ObjType;
  data: Buffer;
  oid: string;
}

function readSizeEncoding(buf: Buffer, pos: number): { type: number; size: number; next: number } {
  let b = buf[pos];
  const type = (b >> 4) & 7;
  let size = b & 0x0f;
  let shift = 4;
  pos++;
  while (b & 0x80) {
    b = buf[pos++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    let b: number;
    do {
      b = delta[pos++];
      out |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return out;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op > 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || total !== targetSize) throw new Error("delta size mismatch");
  return out;
}

export function readPack(buf: Buffer): { objects: PackObject[]; error?: string } {
  try {
    if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "PACK") return { objects: [], error: "not a packfile" };
    const version = buf.readUInt32BE(4);
    if (version !== 2 && version !== 3) return { objects: [], error: `unsupported pack version ${version}` };
    const count = buf.readUInt32BE(8);
    const typeNames: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
    const raw: { type: number; data: Buffer; baseOid?: string; basePos?: number; start: number }[] = [];
    let pos = 12;
    for (let n = 0; n < count; n++) {
      const start = pos;
      const { type, next } = readSizeEncoding(buf, pos);
      pos = next;
      let baseOid: string | undefined;
      let basePos: number | undefined;
      if (type === 6) {
        let b = buf[pos++];
        let offset = b & 0x7f;
        while (b & 0x80) {
          b = buf[pos++];
          offset = ((offset + 1) << 7) | (b & 0x7f);
        }
        basePos = start - offset;
      } else if (type === 7) {
        baseOid = buf.subarray(pos, pos + 20).toString("hex");
        pos += 20;
      }
      const { buffer, engine } = inflateSync(buf.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      pos += engine.bytesWritten;
      raw.push({ type, data: buffer, baseOid, basePos, start });
    }
    // Resolve deltas (bases always precede deltas in practice; loop anyway).
    const byPos = new Map<number, PackObject>();
    const byOid = new Map<string, PackObject>();
    const objects: PackObject[] = [];
    const pending = [...raw];
    let guard = 0;
    while (pending.length && guard++ < pending.length + 2) {
      let progressed = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const r = pending[i];
        if (r.type >= 1 && r.type <= 4) {
          const type = typeNames[r.type];
          const obj: PackObject = { type, data: r.data, oid: objId(type, r.data) };
          objects.push(obj);
          byPos.set(r.start, obj);
          byOid.set(obj.oid, obj);
          pending.splice(i, 1);
          progressed = true;
        } else if (r.type === 6 || r.type === 7) {
          const base = r.type === 6 ? byPos.get(r.basePos!) : byOid.get(r.baseOid!);
          if (!base) continue;
          const data = applyDelta(base.data, r.data);
          const obj: PackObject = { type: base.type, data, oid: objId(base.type, data) };
          objects.push(obj);
          byPos.set(r.start, obj);
          byOid.set(obj.oid, obj);
          pending.splice(i, 1);
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    if (pending.length) return { objects, error: "unresolved delta in pack" };
    return { objects };
  } catch (e) {
    return { objects: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- pack writing (plain objects only) ----

const TYPE_NUMBERS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function writePack(entries: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "ascii");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const e of entries) {
    const typeNum = TYPE_NUMBERS[e.type];
    let size = e.data.length;
    const headerBytes: number[] = [];
    let b = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) b |= 0x80;
    headerBytes.push(b);
    while (size > 0) {
      b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(e.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(requireSha1(body), "hex");
  return Buffer.concat([body, trailer]);
}

function requireSha1(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

// ---- advertisements ----

function refList(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function tagTarget(repo: Repo, tagOid: string): string | null {
  const obj = repo.objects.get(tagOid);
  if (!obj || obj.type !== "tag") return null;
  const m = obj.data.toString("utf8").match(/^object ([0-9a-f]{40})$/m);
  return m ? m[1] : null;
}

const V0_UPLOAD_CAPS =
  "symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done agent=" + AGENT;
const V0_RECEIVE_CAPS =
  "report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=" + AGENT;

export function v0UploadAdvertisement(repo: Repo): Buffer {
  const refs = refList(repo);
  const items: (string | "flush")[] = ["# service=git-upload-pack\n"];
  if (refs.length === 0) {
    items.push(`${ZERO} capabilities^{}\0${V0_UPLOAD_CAPS}\n`, "flush");
    return pktLines(items);
  }
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? refs[0].oid;
  items.push(`${headOid} HEAD\0${V0_UPLOAD_CAPS}\n`);
  for (const r of refs) {
    items.push(`${r.oid} ${r.name}\n`);
    const peeled = tagTarget(repo, r.oid);
    if (peeled) items.push(`${peeled} ${r.name}^{}\n`);
  }
  items.push("flush");
  return pktLines(items);
}

export function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const refs = refList(repo);
  const items: (string | "flush")[] = ["# service=git-receive-pack\n"];
  if (refs.length === 0) {
    items.push(`${ZERO} capabilities^{}\0${V0_RECEIVE_CAPS}\n`, "flush");
    return pktLines(items);
  }
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? refs[0].oid;
  items.push(`${headOid} HEAD\0${V0_RECEIVE_CAPS}\n`);
  for (const r of refs) {
    items.push(`${r.oid} ${r.name}\n`);
    const peeled = tagTarget(repo, r.oid);
    if (peeled) items.push(`${peeled} ${r.name}^{}\n`);
  }
  items.push("flush");
  return pktLines(items);
}

export function v2Advertisement(): Buffer {
  return pktLines([
    "# service=git-upload-pack\n",
    "flush",
    "version 2\n",
    `agent=${AGENT}\n`,
    "ls-refs=unborn\n",
    "fetch=shallow wait-for-done\n",
    "object-format=sha1\n",
    "flush",
  ]);
}

// ---- ls-refs (v2) ----

export function lsRefs(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const refs = refList(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    if (args.unborn && keep("HEAD")) lines.push(`unborn HEAD symref-target:${headRef}\n`);
  } else {
    const headOid = repo.refs.get(headRef) ?? refs[0].oid;
    if (keep("HEAD")) lines.push(`${headOid} HEAD symref-target:${headRef}\n`);
    for (const r of refs) {
      if (!keep(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (args.peel) {
        const peeled = tagTarget(repo, r.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      lines.push(line + "\n");
    }
  }
  lines.push("flush");
  return pktLines(lines as (string | "flush")[]);
}

// ---- fetch ----

export interface FetchRequest {
  wants: string[];
  haves: string[];
  depth: number | null;
  oldShallow: string[];
}

interface FetchSelection {
  commits: string[]; // sent commits, tips first
  objects: { type: ObjType; data: Buffer; oid: string }[];
  shallow: string[];
  unshallow: string[];
}

function resolveWantCommit(repo: Repo, oid: string): { commit: string; tag: string | null } {
  const obj = repo.objects.get(oid);
  if (obj && obj.type === "tag") {
    const target = tagTarget(repo, oid);
    return { commit: target ?? oid, tag: oid };
  }
  return { commit: oid, tag: null };
}

export function selectFetch(store: Store, repo: Repo, req: FetchRequest): FetchSelection {
  // Commits the client already holds: the haves plus their ancestry, but
  // the walk stops at the client's shallow boundaries — a shallow client
  // holds the boundary commit itself, not its parents. (For a full clone
  // there are no boundaries, so this is the full ancestry.)
  const heldCommits = new Set<string>();
  {
    const hq = [...req.haves];
    while (hq.length) {
      const cur = hq.shift()!;
      if (heldCommits.has(cur)) continue;
      heldCommits.add(cur);
      if (req.oldShallow.includes(cur)) continue;
      for (const p of store.commitParents(repo, cur)) hq.push(p);
    }
  }
  const sentCommits = new Set<string>();
  const wantTags: string[] = [];
  const queue: { oid: string; gen: number }[] = [];
  const genOf = new Map<string, number>();
  for (const w of req.wants) {
    const { commit, tag } = resolveWantCommit(repo, w);
    if (tag) wantTags.push(tag);
    if (repo.objects.has(commit)) queue.push({ oid: commit, gen: 0 });
  }
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (!genOf.has(oid) || gen < genOf.get(oid)!) genOf.set(oid, gen);
    if (req.depth !== null && gen >= req.depth) continue;
    if (!heldCommits.has(oid)) sentCommits.add(oid);
    for (const p of store.commitParents(repo, oid)) {
      if (!seen.has(p)) queue.push({ oid: p, gen: gen + 1 });
    }
  }
  // Shallow boundaries: sent commits with a parent outside the sent set.
  const shallow: string[] = [];
  if (req.depth !== null) {
    for (const c of sentCommits) {
      const parents = store.commitParents(repo, c);
      if (parents.some((p) => !sentCommits.has(p))) shallow.push(c);
    }
    // Old boundaries that are still boundaries stay listed.
    for (const b of req.oldShallow) {
      if (shallow.includes(b)) continue;
      const parents = store.commitParents(repo, b);
      if (parents.length > 0 && !parents.every((p) => sentCommits.has(p))) shallow.push(b);
    }
  }
  const unshallow: string[] = [];
  if (req.depth !== null) {
    for (const b of req.oldShallow) {
      const parents = store.commitParents(repo, b);
      if (parents.length > 0 && parents.every((p) => sentCommits.has(p))) unshallow.push(b);
    }
  }
  // Object closure of the held commits (commits plus their trees/blobs).
  const haveObjects = new Set<string>();
  for (const c of heldCommits) {
    haveObjects.add(c);
    collectTreeObjects(store, repo, c, haveObjects);
  }
  const sentObjects = new Map<string, { type: ObjType; data: Buffer; oid: string }>();
  const addObj = (oid: string) => {
    if (haveObjects.has(oid) || sentObjects.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj) sentObjects.set(oid, { type: obj.type, data: obj.data, oid });
  };
  for (const t of wantTags) addObj(t);
  // Commits tips-first (BFS generation order), then trees/blobs sorted by oid.
  const orderedCommits = [...sentCommits].sort((a, b) => (genOf.get(a) ?? 1e9) - (genOf.get(b) ?? 1e9));
  for (const c of orderedCommits) {
    addObj(c);
    collectTreeObjects(store, repo, c, null, addObj);
  }
  const treesBlobs = [...sentObjects.values()].filter((o) => o.type !== "commit").sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const commits = orderedCommits.map((oid) => sentObjects.get(oid)!).filter(Boolean);
  return { commits: orderedCommits, objects: [...commits, ...treesBlobs], shallow, unshallow };
}

function collectTreeObjects(
  store: Store,
  repo: Repo,
  commitOid: string,
  into: Set<string> | null,
  add?: (oid: string) => void,
): void {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== "commit") return;
  const tree = parseCommit(commit.data).tree;
  const walk = (treeOid: string) => {
    if (into) {
      if (into.has(treeOid)) return;
      into.add(treeOid);
    } else if (add) add(treeOid);
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== "tree") return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === "40000") walk(e.oid);
      else if (into) into.add(e.oid);
      else if (add) add(e.oid);
    }
  };
  walk(tree);
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65000;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) {
    // A fetch must carry at least one sideband packet, even when empty.
    const empty = writePack([]);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), empty])));
  }
  return out;
}

export function fetchV2Response(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const sel = selectFetch(store, repo, req);
  const pack = writePack(sel.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine("acknowledgments\n"));
  const acked = req.haves.filter((h) => repo.objects.has(h));
  if (acked.length === 0) {
    parts.push(pktLine("NAK\n"));
  } else {
    for (const h of acked) parts.push(pktLine(`ACK ${h}\n`));
    parts.push(pktLine("ready\n"));
  }
  parts.push(PKT_DELIM);
  parts.push(pktLine("shallow-info\n"));
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(PKT_DELIM);
  parts.push(pktLine("packfile\n"));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function fetchV0Response(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const sel = selectFetch(store, repo, req);
  const pack = writePack(sel.objects);
  const parts: Buffer[] = [];
  const acked = req.haves.filter((h) => repo.objects.has(h));
  if (acked.length === 0) {
    parts.push(pktLine("NAK\n"));
  } else {
    for (const h of acked) parts.push(pktLine(`ACK ${h}\n`));
  }
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---- receive-pack (v0) ----

export interface PushResult {
  unpackOk: boolean;
  unpackDetail?: string;
  report: { ref: string; ok: boolean; reason?: string }[];
  sideband: boolean;
}

export function receivePack(store: Store, repo: Repo, body: Buffer): PushResult {
  const { packets, rest, error } = parsePktLinesUntilFlush(body);
  if (error) return { unpackOk: false, unpackDetail: error, report: [], sideband: false };
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sideband = false;
  for (const p of packets) {
    if (p.kind === "flush") break;
    if (p.kind !== "data") continue;
    let text = p.data.toString("utf8").replace(/\n$/, "");
    const nul = text.indexOf("\0");
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes("side-band-64k")) sideband = true;
      text = text.slice(0, nul);
    }
    const m = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  // The pack follows the flush packet.
  let packObjects: PackObject[] = [];
  if (rest.length > 0) {
    const read = readPack(rest);
    if (read.error) {
      return {
        unpackOk: false,
        unpackDetail: read.error,
        report: commands.map((c) => ({ ref: c.ref, ok: false, reason: "unpack failed" })),
        sideband,
      };
    }
    packObjects = read.objects;
  }
  for (const o of packObjects) {
    if (!repo.objects.has(o.oid)) repo.objects.set(o.oid, { type: o.type, data: o.data });
  }
  const report: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const c of commands) {
    const current = repo.refs.get(c.ref) ?? ZERO;
    let ok = true;
    let reason: string | undefined;
    if (c.newOid === ZERO) {
      // Delete.
      if (current === ZERO) { ok = false; reason = "reference does not exist"; }
      else if (c.oldOid !== current) { ok = false; reason = "old value mismatch"; }
    } else if (c.oldOid === ZERO) {
      // Create.
      if (current !== ZERO) { ok = false; reason = "reference already exists"; }
      else if (!repo.objects.has(c.newOid)) { ok = false; reason = "object not found"; }
    } else {
      // Update.
      if (c.oldOid !== current) { ok = false; reason = "old value mismatch"; }
      else if (!repo.objects.has(c.newOid)) { ok = false; reason = "object not found"; }
      else if (c.ref.startsWith("refs/heads/") && !store.isAncestor(repo, c.oldOid, c.newOid)) {
        ok = false;
        reason = "non-fast-forward";
      }
    }
    if (ok) {
      if (c.newOid === ZERO) repo.refs.delete(c.ref);
      else repo.refs.set(c.ref, c.newOid);
      report.push({ ref: c.ref, ok: true });
    } else {
      report.push({ ref: c.ref, ok: false, reason });
    }
  }
  return { unpackOk: true, report, sideband };
}

export function receivePackResponse(result: PushResult): Buffer {
  const lines: string[] = [];
  if (result.unpackOk) lines.push("unpack ok\n");
  else lines.push(`unpack ${result.unpackDetail ?? "failed"}\n`);
  for (const r of result.report) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? "failed"}\n`);
  }
  const parts: Buffer[] = [];
  if (result.sideband) {
    for (const line of lines) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, "utf8")])));
    }
  } else {
    for (const line of lines) parts.push(pktLine(line));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---- request parsing helpers for handlers ----

export function parseFetchBody(body: Buffer): { req: FetchRequest; command: string; error?: string } {
  const { packets, error } = parsePktLines(body);
  if (error) return { req: { wants: [], haves: [], depth: null, oldShallow: [] }, command: "", error };
  let command = "";
  const req: FetchRequest = { wants: [], haves: [], depth: null, oldShallow: [] };
  for (const p of packets) {
    if (p.kind !== "data") continue;
    const text = p.data.toString("utf8").replace(/\n$/, "");
    if (text.startsWith("command=")) command = text.slice(8);
    else if (text.startsWith("want ")) req.wants.push(text.slice(5).split(" ")[0]);
    else if (text.startsWith("have ")) req.haves.push(text.slice(5).trim());
    else if (text.startsWith("shallow ")) req.oldShallow.push(text.slice(8).trim());
    else if (text.startsWith("deepen ")) {
      const n = parseInt(text.slice(7), 10);
      if (!Number.isNaN(n)) req.depth = n;
    } else if (text.startsWith("ref-prefix ")) {
      // ls-refs only; handled by caller via raw lines.
    }
  }
  return { req, command };
}

export function parseLsRefsBody(body: Buffer): { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[]; error?: string } {
  const { packets, error } = parsePktLines(body);
  const out = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
  if (error) return { ...out, error };
  for (const p of packets) {
    if (p.kind !== "data") continue;
    const text = p.data.toString("utf8").replace(/\n$/, "");
    if (text === "peel") out.peel = true;
    else if (text === "symrefs") out.symrefs = true;
    else if (text === "unborn") out.unborn = true;
    else if (text.startsWith("ref-prefix ")) out.prefixes.push(text.slice(11));
  }
  return out;
}
