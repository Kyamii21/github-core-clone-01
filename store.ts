// In-memory store for the forge: repos, git objects, refs, issues, PRs.
// All timestamps are deterministic (sequence counter), never wall clock,
// so a replay of the same trial produces the same state export.
//
// v2 performance notes (behaviour unchanged from v1):
// - objId hashes header and data with two updates instead of Buffer.concat.
// - commitParents scans only the header's parent lines, no full parse.
// - isAncestor walks parents with an early exit and reuses cached ancestor
//   sets instead of rebuilding a full set for every new tip.
// - timestamp strings are cached per sequence number.
// - every ref/object mutation bumps repo.stateVersion, which the git layer
//   uses to key its cached advertisements and fetch responses.
// - each issue caches its serialized REST JSON, invalidated on mutation.

import { createHash } from "node:crypto";

export const ZERO = "0".repeat(40);
export const DEFAULT_BRANCH = "main";

export function sha1(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

export function objId(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, "utf8");
  // Two updates: no copy of the (possibly large) data buffer.
  return createHash("sha1").update(head).update(data).digest("hex");
}

export type ObjType = "commit" | "tree" | "blob" | "tag";
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string; // without trailing newline
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString("utf8");
  const blank = text.indexOf("\n\n");
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : "";
  const info: CommitInfo = { tree: "", parents: [], author: "", committer: "", message: message.replace(/\n$/, "") };
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) info.tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) info.parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) info.author = line.slice(7);
    else if (line.startsWith("committer ")) info.committer = line.slice(10);
  }
  return info;
}

/** Only the parent oids of a commit buffer, scanned line by line. */
export function parentOids(data: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    const nl = data.indexOf(0x0a, i);
    const end = nl < 0 ? data.length : nl;
    const len = end - i;
    if (len === 0) break; // blank line ends the header
    if (
      len > 7 &&
      data[i] === 0x70 && // p
      data[i + 1] === 0x61 && // a
      data[i + 2] === 0x72 && // r
      data[i + 3] === 0x65 && // e
      data[i + 4] === 0x6e && // n
      data[i + 5] === 0x74 && // t
      data[i + 6] === 0x20
    ) {
      out.push(data.subarray(i + 7, end).toString("ascii"));
    }
    if (nl < 0) break;
    i = nl + 1;
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(i, sp).toString("utf8");
    const name = data.subarray(sp + 1, nul).toString("utf8");
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

// Git tree sort order: names compare as if directories had a trailing "/".
export function treeSortKey(e: TreeEntry): string {
  return e.mode === "40000" ? e.name + "/" : e.name;
}

export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments: { id: number; body: string }[];
  createdSeq: number;
  /** ISO timestamp string for createdSeq, computed once at creation. */
  createdAt: string;
  /** Cached JSON.stringify of the REST issue object; null when stale. */
  jsonCache: string | null;
  /** The baseUrl the cached JSON was built with. */
  jsonBase: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string; // head tip at creation
  baseSha: string; // base tip at creation
  mergeBase: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** ISO timestamp string for createdSeq, computed once at creation. */
  createdAt: string;
  refs: Map<string, string>; // refname -> oid
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  prs: Map<number, PullRequest>;
  labels: Map<string, { name: string; color: string }>;
  counter: number; // shared issue + PR number counter
  commentId: number;
  shallow: Set<string>; // shallow boundary commit oids (per repo, v2 fetch)
  ancCache: Map<string, Set<string>>; // commit oid -> ancestors incl. self
  treeCache: Map<string, Map<string, { oid: string; mode: string }>>; // commit oid -> flat path map
  /** Bumped on every ref or object mutation; keys the git response caches. */
  stateVersion: number;
  /** Cached v0 upload-pack advertisement for the current stateVersion. */
  uplAdv: Buffer | null;
  uplAdvVersion: number;
  /** Cached v0 receive-pack advertisement for the current stateVersion. */
  recvAdv: Buffer | null;
  recvAdvVersion: number;
  /** Cached ls-refs responses, keyed by the argument signature. */
  lsCache: Map<string, { version: number; buf: Buffer }>;
  /** Cached fetch responses, keyed by the request signature. */
  fetchCache: Map<string, { version: number; buf: Buffer }>;
}

export interface Viewer {
  login: string;
  id: number;
  name: string;
  email: string;
}

export const BASE_EPOCH = 1794787200; // 2026-11-16T00:00:00Z, deterministic base

export class Store {
  viewer: Viewer = {
    login: "adaiversen",
    id: 1000,
    name: "ada iversen",
    email: "adaiversen@example.invalid",
  };
  // Owner lock: null until the first repo-scoped request; see resolveOwner.
  private ownerLocked = false;
  private seq = 0;
  private nextRepoId = 5000;
  repos = new Map<string, Repo>(); // keyed by repo name
  /** Deterministic timestamp strings, one per sequence number. */
  private tsCache = new Map<number, string>();

  nextSeq(): number {
    return ++this.seq;
  }

  /** ISO timestamp for a sequence number (cached: the string never changes). */
  tsForSeq(seq: number): string {
    let s = this.tsCache.get(seq);
    if (s === undefined) {
      s = new Date((BASE_EPOCH + seq) * 1000).toISOString();
      this.tsCache.set(seq, s);
    }
    return s;
  }

  timestamp(): string {
    return this.tsForSeq(this.seq);
  }

  tick(): string {
    this.seq++;
    return this.timestamp();
  }

  gitTimestamp(): string {
    // "<unix> +0000" for author/committer lines; advances the clock.
    this.seq++;
    return `${BASE_EPOCH + this.seq} +0000`;
  }

  // Accept an owner for repo-scoped requests. The viewer login is the
  // embedded scenario default; if the first repo-scoped request names a
  // different owner, adopt it (the token names a different login) and lock.
  // Returns true when the owner is accepted, false when it is foreign.
  resolveOwner(owner: string): boolean {
    if (owner === this.viewer.login) {
      this.ownerLocked = true;
      return true;
    }
    if (!this.ownerLocked) {
      this.viewer.login = owner;
      this.viewer.email = `${owner}@example.invalid`;
      this.viewer.name = owner;
      this.ownerLocked = true;
      for (const r of this.repos.values()) r.owner = owner;
      return true;
    }
    return false;
  }

  getRepo(owner: string, name: string): Repo | null {
    const r = this.repos.get(name);
    if (!r) return null;
    if (!this.resolveOwner(owner)) return null;
    return r;
  }

  createRepo(name: string, priv: boolean, description: string): Repo {
    const createdSeq = this.nextSeq();
    const r: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewer.login,
      description,
      priv,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq,
      createdAt: this.tsForSeq(createdSeq),
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      prs: new Map(),
      labels: new Map(),
      counter: 0,
      commentId: 0,
      shallow: new Set(),
      ancCache: new Map(),
      treeCache: new Map(),
      stateVersion: 0,
      uplAdv: null,
      uplAdvVersion: -1,
      recvAdv: null,
      recvAdvVersion: -1,
      lsCache: new Map(),
      fetchCache: new Map(),
    };
    // Seed the six scenario labels so issues may carry them.
    for (const label of ["bug", "enhancement", "documentation", "question", "good first issue", "help wanted"]) {
      r.labels.set(label, { name: label, color: "000000" });
    }
    this.repos.set(name, r);
    return r;
  }

  // ---- refs (centralized so the version counter stays correct) ----

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.stateVersion++;
  }

  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.stateVersion++;
  }

  // ---- git objects ----

  addObject(repo: Repo, type: ObjType, data: Buffer): string {
    const id = objId(type, data);
    if (!repo.objects.has(id)) {
      repo.objects.set(id, { type, data });
      repo.stateVersion++;
    }
    return id;
  }

  /** Store an already-hashed pack object; bumps the version only when new. */
  putObject(repo: Repo, type: ObjType, data: Buffer, oid: string): void {
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.stateVersion++;
    }
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const ts = this.gitTimestamp();
    const author = `${this.viewer.name} <${this.viewer.email}> ${ts}`;
    const lines = [`tree ${treeOid}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${author}`, `committer ${author}`, ``, `${message}\n`);
    return this.addObject(repo, "commit", Buffer.from(lines.join("\n"), "utf8"));
  }

  buildTree(repo: Repo, entries: TreeEntry[]): string {
    return this.addObject(repo, "tree", buildTreeBytes(entries));
  }

  // Flat path -> {oid, mode} map for a commit's tree (blobs only).
  treeMap(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const cached = repo.treeCache.get(commitOid);
    if (cached) return cached;
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = repo.objects.get(commitOid);
    if (commit && commit.type === "commit") {
      const info = parseCommit(commit.data);
      this.flattenTree(repo, info.tree, "", out);
    }
    repo.treeCache.set(commitOid, out);
    return out;
  }

  private flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== "tree") return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === "40000") this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  }

  // Set (or delete, when blobOid is null) one path in a tree, rebuilding
  // nested trees bottom-up. Returns the new root tree oid.
  updateTreePath(repo: Repo, rootTreeOid: string, parts: string[], blobOid: string | null): string {
    const obj = repo.objects.get(rootTreeOid);
    const entries: TreeEntry[] = obj && obj.type === "tree" ? parseTree(obj.data) : [];
    const [head, ...rest] = parts;
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: "100644", name: head, oid: blobOid };
      } else {
        entries.push({ mode: "100644", name: head, oid: blobOid });
      }
    } else {
      const childOid = idx >= 0 && entries[idx].mode === "40000" ? entries[idx].oid : null;
      const empty = this.buildTree(repo, []);
      const next = this.updateTreePath(repo, childOid ?? empty, rest, blobOid);
      if (idx >= 0) entries[idx] = { mode: "40000", name: head, oid: next };
      else entries.push({ mode: "40000", name: head, oid: next });
    }
    return this.buildTree(repo, entries);
  }

  // ---- ancestry ----

  commitParents(repo: Repo, oid: string): string[] {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") return [];
    return parentOids(obj.data);
  }

  ancestors(repo: Repo, oid: string): Set<string> {
    const cached = repo.ancCache.get(oid);
    if (cached) return cached;
    const out = new Set<string>();
    const stack = [oid];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      const hit = repo.ancCache.get(cur);
      if (hit) {
        for (const a of hit) out.add(a);
      } else {
        for (const p of this.commitParents(repo, cur)) stack.push(p);
      }
    }
    repo.ancCache.set(oid, out);
    return out;
  }

  /**
   * True when anc is an ancestor of desc (or equal). Unlike ancestors(),
   * this stops the moment anc is found and never builds a full set: a
   * sequential push chain resolves in a single parent step, where the
   * full-set walk would copy the whole history on every push.
   */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const hit = repo.ancCache.get(cur);
      if (hit) {
        if (hit.has(anc)) return true;
        continue; // the cached set is complete: nothing below cur helps
      }
      for (const p of this.commitParents(repo, cur)) stack.push(p);
    }
    return false;
  }

  // First common ancestor of a and b, walking a's history newest-first.
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const bAnc = this.ancestors(repo, b);
    const seen = new Set<string>();
    const queue = [a];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (bAnc.has(cur)) return cur;
      for (const p of this.commitParents(repo, cur)) queue.push(p);
    }
    return null;
  }

  // Reachable commits from a set of tips, excluding anything reachable
  // from any of the exclude tips.
  reachableCommits(repo: Repo, tips: string[], exclude: string[]): Set<string> {
    const excl = new Set<string>();
    for (const t of exclude) for (const a of this.ancestors(repo, t)) excl.add(a);
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur) || excl.has(cur)) continue;
      if (!repo.objects.has(cur)) continue;
      out.add(cur);
      for (const p of this.commitParents(repo, cur)) stack.push(p);
    }
    return out;
  }

  // ---- diffs ----

  diffFiles(
    repo: Repo,
    baseOid: string,
    headOid: string,
  ): { filename: string; status: "added" | "modified" | "removed"; additions: number; deletions: number; changes: number }[] {
    const base = baseOid === ZERO ? new Map() : this.treeMap(repo, baseOid);
    const head = headOid === ZERO ? new Map() : this.treeMap(repo, headOid);
    const out: { filename: string; status: "added" | "modified" | "removed"; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const lines = this.blobLines(repo, b.oid);
        out.push({ filename: path, status: "removed", additions: 0, deletions: lines, changes: lines });
      } else if (!b && h) {
        const lines = this.blobLines(repo, h.oid);
        out.push({ filename: path, status: "added", additions: lines, deletions: 0, changes: lines });
      } else if (b && h && b.oid !== h.oid) {
        const [add, del] = this.lineDiff(repo, b.oid, h.oid);
        out.push({ filename: path, status: "modified", additions: Math.max(add, 1), deletions: del, changes: add + del });
      }
    }
    return out;
  }

  private blobLines(repo: Repo, oid: string): number {
    const obj = repo.objects.get(oid);
    if (!obj) return 0;
    const text = obj.data.toString("utf8");
    if (text === "") return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }

  // Multiset line diff: lines gained vs lines lost.
  private lineDiff(repo: Repo, oldOid: string, newOid: string): [number, number] {
    const oldObj = repo.objects.get(oldOid);
    const newObj = repo.objects.get(newOid);
    const oldLines = oldObj ? oldObj.data.toString("utf8").split("\n") : [];
    const newLines = newObj ? newObj.data.toString("utf8").split("\n") : [];
    const count = (lines: string[]) => {
      const m = new Map<string, number>();
      for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const a = count(oldLines);
    const b = count(newLines);
    let add = 0;
    let del = 0;
    for (const [line, n] of b) add += Math.max(0, n - (a.get(line) ?? 0));
    for (const [line, n] of a) del += Math.max(0, n - (b.get(line) ?? 0));
    return [add, del];
  }

  // True when head and base both changed the same file differently since
  // the merge base (or one side deleted a file the other modified).
  hasConflict(repo: Repo, pr: PullRequest): boolean {
    const base = pr.mergeBase ?? pr.baseSha;
    const headDiff = this.diffFiles(repo, base, pr.headSha);
    const baseDiff = this.diffFiles(repo, base, pr.baseSha);
    const headMap = new Map(headDiff.map((d) => [d.filename, d]));
    for (const d of baseDiff) {
      const h = headMap.get(d.filename);
      if (!h) continue;
      // Both sides touched the same file; conflict unless the resulting
      // blobs are identical (both changed it to the same content).
      const headBlob = this.treeMap(repo, pr.headSha).get(d.filename)?.oid;
      const baseBlob = this.treeMap(repo, pr.baseSha).get(d.filename)?.oid;
      if (headBlob !== baseBlob) return true;
    }
    return false;
  }

  // ---- global ids (opaque base64) ----

  globalId(kind: string, parts: (string | number)[]): string {
    return Buffer.from([kind, ...parts.map(String)].join(":"), "utf8").toString("base64");
  }

  parseGlobalId(id: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, "base64").toString("utf8");
      const [kind, ...parts] = text.split(":");
      if (!kind || parts.length === 0) return null;
      return { kind, parts };
    } catch {
      return null;
    }
  }
}

export function repoJson(store: Store, r: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: store.viewer.id, type: "User" },
    private: r.priv,
    description: r.description,
    default_branch: r.defaultBranch,
    html_url: `${baseUrl}/${r.owner}/${r.name}`,
    url: `${baseUrl}/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.createdAt,
    updated_at: r.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}
