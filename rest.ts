// REST v3 handlers: repos, branches, refs, commits, contents, labels,
// issues, comments, pull requests.
//
// v2 performance notes (behaviour unchanged from v1):
// - a single issue's JSON is serialized once and cached on the issue
//   (invalidated on any mutation); GET/POST/PATCH of one issue and the
//   issue list serve the cached string without rebuilding or re-stringifying.
// - timestamps come from the store's per-sequence cache, never a new Date.
// - the JSON body parser does not trim (JSON.parse tolerates whitespace).
// - ref mutations go through store.setRef/deleteRef so the git layer's
//   cached advertisements and fetch responses stay correct.

import { Store, type Repo, type Issue, type PullRequest, ZERO, DEFAULT_BRANCH, BASE_EPOCH, repoJson, parseCommit, parseTree } from "./store.ts";

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Pre-serialized JSON body; when present the server sends it as-is. */
  rawBody?: string;
}

export interface RestContext {
  method: string;
  parts: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: Buffer;
  baseUrl: string;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}
function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}
const notFound = (what = "Not Found") => err(404, what);

function parseJsonBody(ctx: RestContext): { value: Record<string, unknown> | null; error?: RestResponse } {
  if (ctx.body.length === 0) return { value: {} };
  try {
    const v = JSON.parse(ctx.body.toString("utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { value: null, error: err(400, "Invalid JSON body") };
    return { value: v as Record<string, unknown> };
  } catch {
    // A whitespace-only body is an empty object, as before.
    if (/^\s*$/.test(ctx.body.toString("utf8"))) return { value: {} };
    return { value: null, error: err(400, "Invalid JSON body") };
  }
}

function issueJson(store: Store, repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? "000000" })),
    user: { login: store.viewer.login, id: store.viewer.id, type: "User" },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The issue's serialized REST JSON, cached on the issue until it mutates. */
function issueJsonRaw(store: Store, repo: Repo, issue: Issue, baseUrl: string): string {
  if (issue.jsonCache !== null && issue.jsonBase === baseUrl) return issue.jsonCache;
  const raw = JSON.stringify(issueJson(store, repo, issue, baseUrl));
  issue.jsonCache = raw;
  issue.jsonBase = baseUrl;
  return raw;
}

/** Drop an issue's cached JSON after any mutation of it. */
function invalidateIssue(issue: Issue): void {
  issue.jsonCache = null;
  issue.jsonBase = null;
}

/** Drop every issue's cached JSON in a repo (a label's color may change). */
function invalidateRepoIssues(repo: Repo): void {
  for (const issue of repo.issues.values()) invalidateIssue(issue);
}

function prJson(store: Store, repo: Repo, pr: PullRequest, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id * 1000000 + pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, repo: { full_name: fullName } },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, repo: { full_name: fullName } },
    user: { login: store.viewer.login, id: store.viewer.id, type: "User" },
    created_at: store.tsForSeq(pr.createdSeq),
    updated_at: store.tsForSeq(pr.createdSeq),
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commitJson(store: Store, repo: Repo, sha: string, baseUrl: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== "commit") return null;
  const info = parseCommit(obj.data);
  const author = { name: store.viewer.name, email: store.viewer.email, date: store.timestamp() };
  return {
    sha,
    commit: {
      message: info.message,
      author,
      committer: author,
      tree: { sha: info.tree },
    },
    parents: info.parents.map((p) => ({ sha: p })),
    author: { login: store.viewer.login },
    committer: { login: store.viewer.login },
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function resolveBranchTip(repo: Repo, ref: string | null): string | null {
  // ref may be a branch name, a full ref, or a commit oid.
  if (!ref) return branchTip(repo, repo.defaultBranch);
  if (ref.startsWith("refs/heads/")) return repo.refs.get(ref) ?? null;
  const byBranch = branchTip(repo, ref);
  if (byBranch) return byBranch;
  if (repo.objects.has(ref)) return ref;
  return null;
}

function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get("per_page") ?? "30", 10) || 30));
  const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = `${baseUrl}${path}?per_page=${perPage}&page=${page + 1}`;
    headers["Link"] = `<${next}>; rel="next"`;
  }
  return { page: slice, headers };
}

export function handleRest(store: Store, ctx: RestContext): RestResponse {
  const { method, parts, query, baseUrl } = ctx;

  // API root.
  if (parts.length === 0) {
    if (method !== "GET") return notFound();
    return ok({
      current_user_url: `${baseUrl}/api/v3/user`,
      current_user_authorizations_html_url: `${baseUrl}/settings/applications`,
      authorizations_url: `${baseUrl}/api/v3/authorizations`,
      code_search_url: `${baseUrl}/api/v3/search/code?q={query}`,
      commit_search_url: `${baseUrl}/api/v3/search/commits?q={query}`,
      emails_url: `${baseUrl}/api/v3/user/emails`,
      emojis_url: `${baseUrl}/api/v3/emojis`,
      events_url: `${baseUrl}/api/v3/events`,
      feeds_url: `${baseUrl}/api/v3/feeds`,
      followers_url: `${baseUrl}/api/v3/user/followers`,
      following_url: `${baseUrl}/api/v3/user/following{/target}`,
      gists_url: `${baseUrl}/api/v3/gists{/gist_id}`,
      hub_url: `${baseUrl}/api/v3/hub`,
      issue_search_url: `${baseUrl}/api/v3/search/issues?q={query}`,
      issues_url: `${baseUrl}/api/v3/issues`,
      keys_url: `${baseUrl}/api/v3/user/keys`,
      label_search_url: `${baseUrl}/api/v3/search/labels?q={query}`,
      notifications_url: `${baseUrl}/api/v3/notifications`,
      organization_repositories_url: `${baseUrl}/api/v3/orgs/{org}/repos`,
      organization_teams_url: `${baseUrl}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${baseUrl}/api/v3/gists/public`,
      rate_limit_url: `${baseUrl}/api/v3/rate_limit`,
      repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${baseUrl}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${baseUrl}/api/v3/user/repos`,
      starred_url: `${baseUrl}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${baseUrl}/api/v3/gists/starred`,
      user_url: `${baseUrl}/api/v3/users/{user}`,
      user_organizations_url: `${baseUrl}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${baseUrl}/api/v3/users/{user}/repos`,
      user_search_url: `${baseUrl}/api/v3/search/users?q={query}`,
    });
  }

  if (parts[0] === "meta") {
    if (method !== "GET") return notFound();
    return ok({ installed_version: "1.0.0", verifiable_password_authentication: true, git: ["1.0.0"], github_services_sha: "1.0.0" });
  }

  if (parts[0] === "user" && parts.length === 1) {
    if (method !== "GET") return notFound();
    const v = store.viewer;
    return ok({
      login: v.login, id: v.id, name: v.name, email: v.email, type: "User",
      avatar_url: "", html_url: `${baseUrl}/${v.login}`, url: `${baseUrl}/api/v3/users/${v.login}`,
      created_at: "2026-11-16T00:00:00Z", updated_at: "2026-11-16T00:00:00Z",
    });
  }

  if (parts[0] === "user" && parts[1] === "repos") {
    if (method === "GET") {
      const all = [...store.repos.values()].filter((r) => r.owner === store.viewer.login);
      const { page, headers } = paginate(all.map((r) => repoJson(store, r, baseUrl)), query, baseUrl, "/api/v3/user/repos");
      return ok(page, 200, headers);
    }
    if (method === "POST") {
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      const name = typeof value!.name === "string" ? value!.name.trim() : "";
      if (!name) return err(400, "name is required");
      if (store.repos.has(name)) return err(422, "name already exists on this account");
      const repo = store.createRepo(name, value!.private === true, typeof value!.description === "string" ? value!.description : "");
      return ok(repoJson(store, repo, baseUrl), 201);
    }
    return notFound();
  }

  if (parts[0] !== "repos" || parts.length < 3) return notFound();
  const [_, owner, repoName, ...rest] = parts;
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound("Not Found");

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === "GET") return ok(repoJson(store, repo, baseUrl));
    if (method === "PATCH") {
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      if (typeof value!.description === "string") repo.description = value!.description;
      if (typeof value!.private === "boolean") repo.priv = value!.private;
      return ok(repoJson(store, repo, baseUrl));
    }
    if (method === "DELETE") {
      store.repos.delete(repoName);
      return { status: 204, body: null };
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === "branches") {
    if (rest.length === 1) {
      if (method !== "GET") return notFound();
      const names = [...repo.refs.keys()]
        .filter((r) => r.startsWith("refs/heads/"))
        .map((r) => r.slice("refs/heads/".length));
      names.sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a < b ? -1 : 1));
      return ok(names.map((n) => ({ name: n, commit: { sha: repo.refs.get(`refs/heads/${n}`) }, protected: false })));
    }
    if (rest.length === 2 && method === "GET") {
      const tip = branchTip(repo, rest[1]);
      if (!tip) return notFound();
      return ok({ name: rest[1], commit: { sha: tip }, protected: false });
    }
    return notFound();
  }

  // Git refs.
  if (rest[0] === "git" && rest[1] === "refs") {
    if (method === "POST" && rest.length === 2) {
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      const ref = typeof value!.ref === "string" ? value!.ref : "";
      const sha = typeof value!.sha === "string" ? value!.sha : "";
      if (!ref.startsWith("refs/") || !/^[0-9a-f]{40}$/.test(sha)) return err(400, "ref and sha are required");
      if (!repo.objects.has(sha)) return err(422, "object does not exist");
      if (repo.refs.has(ref)) return err(422, "Reference already exists");
      store.setRef(repo, ref, sha);
      return ok({ ref, object: { sha }, url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace("refs/", "")}` }, 201);
    }
    if (method === "GET" && rest.length >= 3) {
      const ref = rest.slice(2).join("/");
      const full = `refs/${ref}`;
      const tip = repo.refs.get(full);
      if (!tip) return notFound();
      return ok({ ref: full, object: { sha: tip } });
    }
    return notFound();
  }

  // Commits.
  if (rest[0] === "commits") {
    if (rest.length === 1 && method === "GET") {
      const tip = resolveBranchTip(repo, query.get("sha"));
      if (!tip) return notFound();
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      let cur: string | null = tip;
      while (cur && !seen.has(cur) && out.length < 1000) {
        seen.add(cur);
        const j = commitJson(store, repo, cur, baseUrl);
        if (!j) break;
        out.push(j);
        const obj = repo.objects.get(cur);
        if (!obj || obj.type !== "commit") break;
        cur = parseCommit(obj.data).parents[0] ?? null;
      }
      return ok(out);
    }
    if (rest.length === 2 && method === "GET") {
      const j = commitJson(store, repo, rest[1], baseUrl);
      if (!j) return notFound();
      return ok(j);
    }
    return notFound();
  }

  // Contents.
  if (rest[0] === "contents") {
    const path = rest.slice(1).map(decodeURIComponent).join("/");
    if (method === "GET") {
      const tip = resolveBranchTip(repo, query.get("ref"));
      if (!tip) return notFound();
      const tree = store.treeMap(repo, tip);
      if (path === "") {
        // Root listing.
        const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
        for (const [p, v] of tree) {
          const first = p.split("/")[0];
          if (!children.has(first)) {
            children.set(first, { type: p.includes("/") ? "dir" : "file", name: first, path: first, sha: v.oid });
          }
        }
        return ok([...children.values()]);
      }
      const file = tree.get(path);
      if (file) {
        const blob = repo.objects.get(file.oid);
        const content = blob ? blob.data.toString("base64") : "";
        return ok({
          type: "file", encoding: "base64", size: blob ? blob.data.length : 0,
          name: path.split("/").pop(), path, content, sha: file.oid,
        });
      }
      // Directory listing.
      const prefix = path + "/";
      const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
      let found = false;
      for (const [p, v] of tree) {
        if (!p.startsWith(prefix)) continue;
        found = true;
        const restPath = p.slice(prefix.length);
        const first = restPath.split("/")[0];
        if (!children.has(first)) {
          children.set(first, {
            type: restPath.includes("/") ? "dir" : "file",
            name: first, path: `${path}/${first}`, sha: v.oid,
          });
        }
      }
      if (!found) return notFound();
      return ok([...children.values()]);
    }
    if (method === "PUT") {
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      const message = typeof value!.message === "string" ? value!.message : "";
      const contentB64 = typeof value!.content === "string" ? value!.content : "";
      if (!message || !contentB64) return err(400, "message and content are required");
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, "base64");
      } catch {
        return err(400, "content must be base64");
      }
      const branch = typeof value!.branch === "string" ? value!.branch : repo.defaultBranch;
      let tip = branchTip(repo, branch);
      if (!tip) {
        if (branch === repo.defaultBranch) tip = null; // unborn repo
        else {
          const base = branchTip(repo, repo.defaultBranch);
          if (!base) return notFound("branch does not exist");
          store.setRef(repo, `refs/heads/${branch}`, base);
          tip = base;
        }
      }
      const tree = tip ? store.treeMap(repo, tip) : new Map();
      const existing = tree.get(path);
      const sha = typeof value!.sha === "string" ? value!.sha : undefined;
      if (sha !== undefined && (!existing || existing.oid !== sha)) {
        return err(409, "sha does not match the current blob");
      }
      if (existing && sha === undefined) return err(422, "sha is required to update a file");
      const isCreate = !existing;
      const blobOid = store.addObject(repo, "blob", content);
      const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : store.buildTree(repo, []);
      const newTree = store.updateTreePath(repo, baseTree, path.split("/"), blobOid);
      const commitOid = store.makeCommit(repo, newTree, tip ? [tip] : [], message);
      store.setRef(repo, `refs/heads/${branch}`, commitOid);
      return ok({
        content: { name: path.split("/").pop(), path, sha: blobOid, size: content.length, encoding: "base64", type: "file" },
        commit: { sha: commitOid, message },
      }, isCreate ? 201 : 200);
    }
    if (method === "DELETE") {
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      const branch = typeof value!.branch === "string" ? value!.branch : repo.defaultBranch;
      const tip = branchTip(repo, branch);
      if (!tip) return notFound();
      const tree = store.treeMap(repo, tip);
      const existing = tree.get(path);
      if (!existing) return notFound();
      const sha = typeof value!.sha === "string" ? value!.sha : "";
      if (sha && existing.oid !== sha) return err(409, "sha does not match the current blob");
      const message = typeof value!.message === "string" ? value!.message : "Delete file";
      const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
      const newTree = store.updateTreePath(repo, baseTree, path.split("/"), null);
      const commitOid = store.makeCommit(repo, newTree, [tip], message);
      store.setRef(repo, `refs/heads/${branch}`, commitOid);
      return ok({ commit: { sha: commitOid, message } });
    }
    return notFound();
  }

  // Labels.
  if (rest[0] === "labels") {
    if (rest.length === 1 && method === "GET") {
      return ok([...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: "" })));
    }
    if (rest.length === 1 && method === "POST") {
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      const name = typeof value!.name === "string" ? value!.name.trim() : "";
      if (!name) return err(400, "name is required");
      const color = typeof value!.color === "string" ? value!.color : "000000";
      repo.labels.set(name, { name, color });
      invalidateRepoIssues(repo);
      return ok({ name, color, description: "" }, 201);
    }
    return notFound();
  }

  // Issues.
  if (rest[0] === "issues") {
    if (rest.length === 1 && method === "GET") {
      const state = query.get("state") ?? "open";
      const direction = query.get("direction") ?? "desc";
      let list = [...repo.issues.values()];
      if (state !== "all") list = list.filter((i) => i.state === state);
      list.sort((a, b) => (direction === "asc" ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, headers } = paginate(list, query, baseUrl, `/api/v3/repos/${owner}/${repoName}/issues`);
      const raw = `[${page.map((i) => issueJsonRaw(store, repo, i, baseUrl)).join(",")}]`;
      return { status: 200, body: null, headers, rawBody: raw };
    }
    if (rest.length === 1 && method === "POST") {
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      const title = typeof value!.title === "string" ? value!.title : "";
      if (!title) return err(400, "title is required");
      const labels = Array.isArray(value!.labels) ? (value!.labels as unknown[]).map(String) : [];
      for (const l of labels) {
        if (!repo.labels.has(l)) return err(422, `label "${l}" does not exist`);
      }
      const number = ++repo.counter;
      const createdSeq = store.nextSeq();
      const issue: Issue = {
        number,
        title,
        body: typeof value!.body === "string" ? value!.body : "",
        state: "open",
        labels,
        comments: [],
        createdSeq,
        createdAt: store.tsForSeq(createdSeq),
        jsonCache: null,
        jsonBase: null,
      };
      repo.issues.set(number, issue);
      return { status: 201, body: null, rawBody: issueJsonRaw(store, repo, issue, baseUrl) };
    }
    const num = parseInt(rest[1] ?? "", 10);
    if (Number.isNaN(num)) return notFound();
    if (rest.length === 2 && method === "GET") {
      const issue = repo.issues.get(num);
      if (!issue) return notFound();
      return { status: 200, body: null, rawBody: issueJsonRaw(store, repo, issue, baseUrl) };
    }
    if (rest.length === 2 && method === "PATCH") {
      const issue = repo.issues.get(num);
      if (!issue) return notFound();
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      if (typeof value!.title === "string") issue.title = value!.title;
      if (typeof value!.body === "string") issue.body = value!.body;
      if (value!.state === "open" || value!.state === "closed") issue.state = value!.state;
      if (Array.isArray(value!.labels)) {
        const labels = (value!.labels as unknown[]).map(String);
        for (const l of labels) if (!repo.labels.has(l)) return err(422, `label "${l}" does not exist`);
        issue.labels = labels;
      }
      invalidateIssue(issue);
      return { status: 200, body: null, rawBody: issueJsonRaw(store, repo, issue, baseUrl) };
    }
    if (rest.length === 3 && rest[2] === "comments") {
      const issue = repo.issues.get(num);
      if (!issue) return notFound();
      if (method === "GET") {
        return ok(issue.comments.map((c) => ({
          id: c.id, body: c.body,
          user: { login: store.viewer.login, id: store.viewer.id },
          created_at: store.timestamp(),
        })));
      }
      if (method === "POST") {
        const { value, error } = parseJsonBody(ctx);
        if (error) return error;
        const body = typeof value!.body === "string" ? value!.body : "";
        if (!body) return err(400, "body is required");
        const comment = { id: ++repo.commentId, body };
        issue.comments.push(comment);
        invalidateIssue(issue);
        return ok({
          id: comment.id, body,
          user: { login: store.viewer.login, id: store.viewer.id },
          created_at: store.timestamp(),
        }, 201);
      }
    }
    return notFound();
  }

  // Pull requests.
  if (rest[0] === "pulls") {
    if (rest.length === 1 && method === "GET") {
      const state = query.get("state") ?? "open";
      let list = [...repo.prs.values()];
      if (state !== "all") list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return ok(list.map((p) => prJson(store, repo, p, baseUrl)));
    }
    if (rest.length === 1 && method === "POST") {
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      const title = typeof value!.title === "string" ? value!.title : "";
      const head = typeof value!.head === "string" ? value!.head : "";
      const base = typeof value!.base === "string" ? value!.base : "";
      if (!title || !head || !base) return err(400, "title, head and base are required");
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (!headSha || !baseSha) return err(422, "head or base branch does not exist");
      for (const p of repo.prs.values()) {
        if (p.state === "open" && p.headRef === head && p.baseRef === base) {
          return err(422, "a pull request already exists for this head and base");
        }
      }
      const number = ++repo.counter;
      const pr: PullRequest = {
        number,
        title,
        body: typeof value!.body === "string" ? value!.body : "",
        state: "open",
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeBase: store.mergeBase(repo, headSha, baseSha),
        createdSeq: store.nextSeq(),
      };
      repo.prs.set(number, pr);
      return ok(prJson(store, repo, pr, baseUrl), 201);
    }
    const num = parseInt(rest[1] ?? "", 10);
    if (Number.isNaN(num)) return notFound();
    const pr = repo.prs.get(num);
    if (rest.length === 2 && method === "GET") {
      if (!pr) return notFound();
      return ok(prJson(store, repo, pr, baseUrl));
    }
    if (rest.length === 2 && method === "PATCH") {
      if (!pr) return notFound();
      const { value, error } = parseJsonBody(ctx);
      if (error) return error;
      if (typeof value!.title === "string") pr.title = value!.title;
      if (typeof value!.body === "string") pr.body = value!.body;
      if (value!.state === "closed" && pr.state === "open") pr.state = "closed";
      return ok(prJson(store, repo, pr, baseUrl));
    }
    if (rest.length === 3 && rest[2] === "files" && method === "GET") {
      if (!pr) return notFound();
      const headTip = branchTip(repo, pr.headRef) ?? pr.headSha;
      const files = store.diffFiles(repo, pr.baseSha, headTip);
      return ok(files.map((f) => ({
        filename: f.filename, status: f.status,
        additions: f.additions, deletions: f.deletions, changes: f.changes,
      })));
    }
    if (rest.length === 3 && rest[2] === "merge" && method === "PUT") {
      if (!pr) return notFound();
      if (pr.merged || pr.state === "closed") return err(405, "pull request is already closed");
      const headTip = branchTip(repo, pr.headRef);
      const baseTip = branchTip(repo, pr.baseRef);
      if (!headTip || !baseTip) return notFound("head or base branch is gone");
      const fresh: PullRequest = { ...pr, headSha: headTip, baseSha: baseTip, mergeBase: store.mergeBase(repo, headTip, baseTip) };
      if (store.hasConflict(repo, fresh)) return err(405, "merge conflict");
      const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
      const mergeSha = store.makeCommit(repo, headTree, [baseTip], `Merge pull request #${num} from ${pr.headRef}`);
      store.setRef(repo, `refs/heads/${pr.baseRef}`, mergeSha);
      pr.state = "closed";
      pr.merged = true;
      pr.mergedAt = store.tick();
      pr.mergeCommitSha = mergeSha;
      return ok({ merged: true, sha: mergeSha, message: "Pull Request successfully merged" });
    }
    return notFound();
  }

  return notFound();
}
