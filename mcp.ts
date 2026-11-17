// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
// via server/discover plus the legacy initialize handshake. Tools act on
// the same store as REST.
import { Store, type Repo, type Issue, type PullRequest, repoJson, parseCommit } from "./store.ts";

export interface McpResponse {
  status: number;
  body: unknown; // JSON value, or null for an empty body
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the viewer.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login of the new repository" },
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repository is private" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body" },
        labels: { type: "string", description: "Comma-separated label names" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", description: "Issue state: open, closed, or all" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_issue",
    description: "Get a single issue by number.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        issue_number: { type: "integer", description: "Issue number" },
      },
      required: ["owner", "repo", "issue_number"],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request from a head branch into a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Pull request title" },
        body: { type: "string", description: "Pull request body" },
        head: { type: "string", description: "Head branch name" },
        base: { type: "string", description: "Base branch name" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", description: "Pull request state: open, closed, or all" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request with a squash commit.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        pull_number: { type: "integer", description: "Pull request number" },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

const SERVER_INFO = { name: "github-forge", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

// Map caller argument names onto canonical property names.
function normalizeArgs(args: Record<string, unknown>, aliases: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const n = normalizeKey(k);
    const canonical = aliases[n] ?? n;
    out[canonical] = v;
  }
  return out;
}

const COMMON_ALIASES: Record<string, string> = {
  repository: "repo",
  repositoryname: "repo",
  reponame: "repo",
  pullnumber: "pull_number",
  pullrequestnumber: "pull_number",
  number: "pull_number",
  issuenumber: "issue_number",
  full_name: "full_name",
  fullname: "full_name",
};

function toolResult(id: unknown, obj: unknown, isError = false): McpResponse {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id: id ?? null,
      result: {
        content: [{ type: "text", text }],
        structuredContent: typeof obj === "object" && obj !== null ? obj : { result: obj },
        isError,
      },
    },
  };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: store.viewer.login },
    comments: issue.comments.length,
  };
}

function prJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
  };
}

function doMerge(store: Store, repo: Repo, pr: PullRequest): { ok: boolean; sha?: string; reason?: string } {
  if (pr.merged || pr.state === "closed") return { ok: false, reason: "pull request is already closed" };
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!headTip || !baseTip) return { ok: false, reason: "head or base branch is gone" };
  const fresh: PullRequest = { ...pr, headSha: headTip, baseSha: baseTip, mergeBase: store.mergeBase(repo, headTip, baseTip) };
  if (store.hasConflict(repo, fresh)) return { ok: false, reason: "merge conflict" };
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const mergeSha = store.makeCommit(repo, headTree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
  store.setRef(repo, `refs/heads/${pr.baseRef}`, mergeSha);
  pr.state = "closed";
  pr.merged = true;
  pr.mergedAt = store.tick();
  pr.mergeCommitSha = mergeSha;
  return { ok: true, sha: mergeSha };
}

function callTool(store: Store, baseUrl: string, id: unknown, name: string, rawArgs: Record<string, unknown>): McpResponse {
  const short = name.split("__").pop()!.toLowerCase();
  const tool = TOOLS.find((t) => t.name === short);
  if (!tool) return rpcError(id, -32601, `unknown tool: ${name}`);
  const args = normalizeArgs(rawArgs, COMMON_ALIASES);
  const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === "");
  if (missing.length) return rpcError(id, -32602, `missing required argument(s): ${missing.join(", ")}`);

  const owner = String(args.owner ?? store.viewer.login);
  const repoName = String(args.repo ?? args.name ?? "");
  const getRepo = (): Repo | null => (repoName ? store.getRepo(owner, repoName) : null);

  switch (tool.name) {
    case "create_repo": {
      const repoOwner = String(args.owner ?? store.viewer.login);
      if (repoOwner !== store.viewer.login) {
        return toolResult(id, `owner ${repoOwner} does not match the viewer`, true);
      }
      const name = String(args.name);
      if (store.repos.has(name)) return toolResult(id, "name already exists on this account", true);
      const repo = store.createRepo(name, args.private === true, typeof args.description === "string" ? args.description : "");
      const out = { ...repoJson(store, repo, baseUrl), full_name: `${repo.owner}/${repo.name}` };
      return toolResult(id, out);
    }
    case "get_repo": {
      const repo = getRepo();
      if (!repo) return toolResult(id, "repository not found", true);
      return toolResult(id, { ...repoJson(store, repo, baseUrl), full_name: `${repo.owner}/${repo.name}` });
    }
    case "create_issue": {
      const repo = getRepo();
      if (!repo) return toolResult(id, "repository not found", true);
      const labels = typeof args.labels === "string"
        ? args.labels.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      for (const l of labels) if (!repo.labels.has(l)) return toolResult(id, `label "${l}" does not exist`, true);
      const number = ++repo.counter;
      const createdSeq = store.nextSeq();
      const issue: Issue = {
        number,
        title: String(args.title),
        body: typeof args.body === "string" ? args.body : "",
        state: "open",
        labels,
        comments: [],
        createdSeq,
        createdAt: store.tsForSeq(createdSeq),
        jsonCache: null,
        jsonBase: null,
      };
      repo.issues.set(number, issue);
      return toolResult(id, issueJson(store, repo, issue));
    }
    case "list_issues": {
      const repo = getRepo();
      if (!repo) return toolResult(id, "repository not found", true);
      const state = String(args.state ?? "open");
      let list = [...repo.issues.values()];
      if (state !== "all") list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const issues = list.map((i) => issueJson(store, repo, i));
      return toolResult(id, { issues });
    }
    case "get_issue": {
      const repo = getRepo();
      if (!repo) return toolResult(id, "issue not found", true);
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return toolResult(id, "issue not found", true);
      return toolResult(id, issueJson(store, repo, issue));
    }
    case "create_pull_request": {
      const repo = getRepo();
      if (!repo) return toolResult(id, "repository not found", true);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolResult(id, "head or base branch does not exist", true);
      for (const p of repo.prs.values()) {
        if (p.state === "open" && p.headRef === head && p.baseRef === base) {
          return toolResult(id, prJson(store, repo, p));
        }
      }
      const number = ++repo.counter;
      const pr: PullRequest = {
        number,
        title: String(args.title),
        body: typeof args.body === "string" ? args.body : "",
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
      return toolResult(id, prJson(store, repo, pr));
    }
    case "list_pull_requests": {
      const repo = getRepo();
      if (!repo) return toolResult(id, "repository not found", true);
      const state = String(args.state ?? "open");
      let list = [...repo.prs.values()];
      if (state !== "all") list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult(id, { pull_requests: list.map((p) => prJson(store, repo, p)) });
    }
    case "merge_pull_request": {
      const repo = getRepo();
      if (!repo) return toolResult(id, "repository not found", true);
      const pr = repo.prs.get(Number(args.pull_number));
      if (!pr) return toolResult(id, "pull request not found", true);
      const res = doMerge(store, repo, pr);
      if (!res.ok) return toolResult(id, res.reason ?? "merge failed", true);
      return toolResult(id, { merged: true, sha: res.sha, number: pr.number, ...prJson(store, repo, pr) });
    }
    default:
      return rpcError(id, -32601, `unknown tool: ${name}`);
  }
}

export function handleMcp(store: Store, baseUrl: string, body: Buffer, authorized: boolean): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } };
  }
  const runOne = (msg: Record<string, unknown>): McpResponse => {
    const id = (msg.id as string | number | null) ?? null;
    const method = String(msg.method ?? "");
    if (method === "server/discover") {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: "A GitHub-compatible git forge: create and read repositories, issues and pull requests.",
            _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
          },
        },
      };
    }
    if (method === "initialize") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : "2025-11-25";
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        },
      };
    }
    if (method === "notifications/initialized") {
      return { status: 202, body: null };
    }
    if (method === "ping") {
      return { status: 200, body: { jsonrpc: "2.0", id, result: {} } };
    }
    if (method === "tools/list") {
      return { status: 200, body: { jsonrpc: "2.0", id, result: { tools: TOOLS } } };
    }
    if (method === "tools/call") {
      if (!authorized) {
        return { status: 401, body: { jsonrpc: "2.0", id, error: { code: -32001, message: "Unauthorized" } } };
      }
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return callTool(store, baseUrl, id, name, args);
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  };
  if (Array.isArray(parsed)) {
    const out = (parsed as Record<string, unknown>[]).map((m) => runOne(m).body);
    return { status: 200, body: out };
  }
  if (parsed && typeof parsed === "object") return runOne(parsed as Record<string, unknown>);
  return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } };
}
