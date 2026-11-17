// GraphQL v4: a small tokenizer + recursive parser and an executor for the
// documents gh and github-mcp-server send (viewer, repository, issue(s),
// pullRequest(s), node(id), __type introspection, batched documents, and
// the create/close/merge/comment mutations).
import { Store, type Repo, type Issue, type PullRequest, parseCommit } from "./store.ts";

// ---- tokenizer ----

type Token =
  | { kind: "braceL" } | { kind: "braceR" } | { kind: "parenL" } | { kind: "parenR" }
  | { kind: "bracketL" } | { kind: "bracketR" } | { kind: "colon" } | { kind: "dollar" }
  | { kind: "bang" } | { kind: "spread" } | { kind: "equals" } | { kind: "at" }
  | { kind: "name"; value: string } | { kind: "int"; value: number }
  | { kind: "string"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") { i++; continue; }
    if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "{") { tokens.push({ kind: "braceL" }); i++; continue; }
    if (c === "}") { tokens.push({ kind: "braceR" }); i++; continue; }
    if (c === "(") { tokens.push({ kind: "parenL" }); i++; continue; }
    if (c === ")") { tokens.push({ kind: "parenR" }); i++; continue; }
    if (c === "[") { tokens.push({ kind: "bracketL" }); i++; continue; }
    if (c === "]") { tokens.push({ kind: "bracketR" }); i++; continue; }
    if (c === ":") { tokens.push({ kind: "colon" }); i++; continue; }
    if (c === "$") { tokens.push({ kind: "dollar" }); i++; continue; }
    if (c === "!") { tokens.push({ kind: "bang" }); i++; continue; }
    if (c === "=") { tokens.push({ kind: "equals" }); i++; continue; }
    if (c === "@") { tokens.push({ kind: "at" }); i++; continue; }
    if (c === "." && src.slice(i, i + 3) === "...") { tokens.push({ kind: "spread" }); i += 3; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else if (esc === "r") out += "\r";
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === "-") j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (j < src.length && src[j] === ".") {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: "int", value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: "name", value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// ---- AST ----

interface Argument { name: string; value: ValueNode }
type ValueNode =
  | { kind: "variable"; name: string }
  | { kind: "int"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: ValueNode[] }
  | { kind: "object"; fields: { name: string; value: ValueNode }[] };

interface FieldSelection {
  kind: "field";
  name: string;
  alias?: string;
  args: Argument[];
  selections: Selection[];
}
interface InlineFragment {
  kind: "inlineFragment";
  typeCondition?: string;
  selections: Selection[];
}
interface FragmentSpread { kind: "fragmentSpread"; name: string }
type Selection = FieldSelection | InlineFragment | FragmentSpread;

interface Operation {
  type: "query" | "mutation";
  name?: string;
  variableDefinitions: { name: string; defaultValue?: ValueNode }[];
  selections: Selection[];
}
interface Fragment { name: string; typeCondition: string; selections: Selection[] }
interface Document { operations: Operation[]; fragments: Map<string, Fragment> }

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error("unexpected end of document");
    this.pos++;
    return t;
  }
  private expect(kind: Token["kind"]): Token {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind}`);
    return t;
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== "name") throw new Error(`expected name, got ${t.kind}`);
    if (value && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): Document {
    const doc: Document = { operations: [], fragments: new Map() };
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === "braceL") {
        doc.operations.push({ type: "query", variableDefinitions: [], selections: this.parseSelectionSet() });
      } else if (t.kind === "name" && (t.value === "query" || t.value === "mutation")) {
        const type = this.next().value as "query" | "mutation";
        let name: string | undefined;
        const nxt = this.peek();
        if (nxt && nxt.kind === "name") name = this.next().value as string;
        const variableDefinitions = this.parseVariableDefinitions();
        const selections = this.parseSelectionSet();
        doc.operations.push({ type, name, variableDefinitions, selections });
      } else if (t.kind === "name" && t.value === "fragment") {
        this.next();
        const name = this.expectName();
        this.expectName("on");
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        doc.fragments.set(name, { name, typeCondition, selections });
      } else {
        throw new Error(`unexpected token ${t.kind}`);
      }
    }
    return doc;
  }

  private parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    const defs: { name: string; defaultValue?: ValueNode }[] = [];
    if (this.peek()?.kind !== "parenL") return defs;
    this.next();
    while (this.peek()?.kind !== "parenR") {
      this.expect("dollar");
      const name = this.expectName();
      this.expect("colon");
      this.parseType();
      if (this.peek()?.kind === "equals") {
        this.next();
        defs.push({ name, defaultValue: this.parseValue() });
      } else {
        defs.push({ name });
      }
    }
    this.expect("parenR");
    return defs;
  }

  private parseType(): void {
    const t = this.next();
    if (t.kind === "bracketL") {
      this.parseType();
      this.expect("bracketR");
    } else if (t.kind !== "name") {
      throw new Error(`expected type, got ${t.kind}`);
    }
    if (this.peek()?.kind === "bang") this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expect("braceL");
    const selections: Selection[] = [];
    while (this.peek()?.kind !== "braceR") {
      selections.push(this.parseSelection());
    }
    this.expect("braceR");
    return selections;
  }

  private parseSelection(): Selection {
    const t = this.peek()!;
    if (t.kind === "spread") {
      this.next();
      const nxt = this.peek()!;
      if (nxt.kind === "name" && nxt.value === "on") {
        this.next();
        const typeCondition = this.expectName();
        return { kind: "inlineFragment", typeCondition, selections: this.parseSelectionSet() };
      }
      if (nxt.kind === "name") {
        const name = this.next().value as string;
        // Fragment directives (e.g. @include) are not used by the suite; skip them.
        while (this.peek()?.kind === "at") {
          this.next();
          this.expectName();
          if (this.peek()?.kind === "parenL") this.parseArguments();
        }
        return { kind: "fragmentSpread", name };
      }
      return { kind: "inlineFragment", selections: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | undefined;
    let fieldName = name;
    if (this.peek()?.kind === "colon") {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args = this.parseArguments();
    // Skip field directives.
    while (this.peek()?.kind === "at") {
      this.next();
      this.expectName();
      if (this.peek()?.kind === "parenL") this.parseArguments();
    }
    const selections = this.peek()?.kind === "braceL" ? this.parseSelectionSet() : [];
    return { kind: "field", name: fieldName, alias, args, selections };
  }

  private parseArguments(): Argument[] {
    const args: Argument[] = [];
    if (this.peek()?.kind !== "parenL") return args;
    this.next();
    while (this.peek()?.kind !== "parenR") {
      const name = this.expectName();
      this.expect("colon");
      args.push({ name, value: this.parseValue() });
    }
    this.expect("parenR");
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    switch (t.kind) {
      case "dollar": return { kind: "variable", name: this.expectName() };
      case "int": return { kind: "int", value: t.value };
      case "string": return { kind: "string", value: t.value };
      case "bracketL": {
        const values: ValueNode[] = [];
        while (this.peek()?.kind !== "bracketR") values.push(this.parseValue());
        this.expect("bracketR");
        return { kind: "list", values };
      }
      case "braceL": {
        const fields: { name: string; value: ValueNode }[] = [];
        while (this.peek()?.kind !== "braceR") {
          const name = this.expectName();
          this.expect("colon");
          fields.push({ name, value: this.parseValue() });
        }
        this.expect("braceR");
        return { kind: "object", fields };
      }
      case "name":
        if (t.value === "true") return { kind: "boolean", value: true };
        if (t.value === "false") return { kind: "boolean", value: false };
        if (t.value === "null") return { kind: "null" };
        return { kind: "enum", value: t.value };
      default:
        throw new Error(`unexpected value token ${t.kind}`);
    }
  }
}

// ---- executor ----

interface GqlContext {
  store: Store;
  baseUrl: string;
  vars: Record<string, unknown>;
  errors: { message: string }[];
}

type GqlObject = Record<string, unknown> & { __typename: string };

const FIELDS: Record<string, Set<string>> = {
  Query: new Set(["viewer", "repository", "node", "__type", "__schema", "search"]),
  Viewer: new Set(["login", "id", "name", "email", "url", "avatarUrl"]),
  User: new Set(["login", "id", "name", "email", "url", "avatarUrl"]),
  Repository: new Set(["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequest", "pullRequests", "url", "description", "isPrivate"]),
  Issue: new Set(["id", "databaseId", "number", "title", "body", "state", "url", "author", "createdAt"]),
  PullRequest: new Set(["id", "databaseId", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "headRefOid", "baseRefOid", "files", "url", "author", "createdAt"]),
  IssueConnection: new Set(["nodes", "edges", "pageInfo", "totalCount"]),
  PullRequestConnection: new Set(["nodes", "edges", "pageInfo", "totalCount"]),
  PullRequestChangedFileConnection: new Set(["nodes", "edges", "pageInfo", "totalCount"]),
  PullRequestChangedFile: new Set(["path", "additions", "deletions", "changeType"]),
  IssueEdge: new Set(["node", "cursor"]),
  PullRequestEdge: new Set(["node", "cursor"]),
  PullRequestChangedFileEdge: new Set(["node", "cursor"]),
  PageInfo: new Set(["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"]),
  Ref: new Set(["name", "target"]),
  __Type: new Set(["name", "kind", "fields", "enumValues", "description"]),
  __Field: new Set(["name", "description", "type"]),
  __EnumValue: new Set(["name", "description"]),
  __Schema: new Set(["queryType", "mutationType", "types"]),
  Mutation: new Set(["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"]),
  CreateIssuePayload: new Set(["issue", "clientMutationId"]),
  CloseIssuePayload: new Set(["issue", "clientMutationId"]),
  CreatePullRequestPayload: new Set(["pullRequest", "clientMutationId"]),
  MergePullRequestPayload: new Set(["pullRequest", "clientMutationId"]),
  AddCommentPayload: new Set(["commentEdge", "comment", "clientMutationId"]),
  IssueCommentEdge: new Set(["node", "cursor"]),
  IssueComment: new Set(["id", "body", "author"]),
  SearchResultItemConnection: new Set(["nodes", "edges", "pageInfo", "totalCount"]),
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ["id", "number", "title", "state", "body", "url", "author", "createdAt", "databaseId"],
  PullRequest: ["id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files", "title", "body", "url", "author", "createdAt", "databaseId"],
  Repository: ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "url", "description", "isPrivate"],
  Viewer: ["login", "id", "name", "email", "url"],
  User: ["login", "id", "name", "email", "url"],
  SearchType: [],
};

function valueOf(node: ValueNode, ctx: GqlContext): unknown {
  switch (node.kind) {
    case "variable": return ctx.vars[node.name] ?? null;
    case "int": return node.value;
    case "string": return node.value;
    case "boolean": return node.value;
    case "null": return null;
    case "enum": return node.value;
    case "list": return node.values.map((v) => valueOf(v, ctx));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, ctx);
      return out;
    }
  }
}

function argMap(args: Argument[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = valueOf(a.value, ctx);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, "utf8").toString("base64");
}
function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, "base64").toString("utf8");
    const m = text.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function repoById(store: Store, id: number): Repo | null {
  for (const r of store.repos.values()) if (r.id === id) return r;
  return null;
}

function issueObj(store: Store, repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: "Issue",
    __repo: repo,
    __issue: issue,
    id: store.globalId("Issue", [repo.id, issue.number]),
    databaseId: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === "open" ? "OPEN" : "CLOSED",
    url: `${store.viewer.login}/${repo.name}/issues/${issue.number}`,
  };
}

function prObj(store: Store, repo: Repo, pr: PullRequest): GqlObject {
  return {
    __typename: "PullRequest",
    __repo: repo,
    __pr: pr,
    id: store.globalId("PullRequest", [repo.id, pr.number]),
    databaseId: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
  };
}

function repoObj(store: Store, repo: Repo): GqlObject {
  return {
    __typename: "Repository",
    __repo: repo,
    id: store.globalId("Repository", [repo.id]),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: "User", login: repo.owner, id: store.viewer.id, name: repo.owner, email: `${repo.owner}@example.invalid` } as GqlObject,
    defaultBranchRef: { __typename: "Ref", name: repo.defaultBranch } as GqlObject,
    viewerPermission: "ADMIN",
    hasIssuesEnabled: true,
    url: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.priv,
  };
}

function connection<T extends GqlObject>(items: T[], first: number | undefined, after: string | undefined, typeName: string, edgeType: string): GqlObject {
  let start = 0;
  if (after) {
    const n = numberFromCursor(after);
    if (n !== null) {
      const idx = items.findIndex((it) => (it.number as number) === n);
      if (idx >= 0) start = idx + 1;
    }
  }
  const page = first !== undefined ? items.slice(start, start + first) : items.slice(start);
  const endCursor = page.length ? cursorFor(page[page.length - 1].number as number) : null;
  return {
    __typename: typeName,
    nodes: page,
    edges: page.map((node) => ({ __typename: edgeType, node, cursor: cursorFor(node.number as number) } as GqlObject)),
    pageInfo: {
      __typename: "PageInfo",
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length ? cursorFor(page[0].number as number) : null,
      endCursor,
    } as GqlObject,
    totalCount: items.length,
  };
}

function resolveField(typeName: string, obj: GqlObject, field: FieldSelection, ctx: GqlContext, doc: Document): unknown {
  const store = ctx.store;
  const args = argMap(field.args, ctx);
  switch (typeName) {
    case "Query": {
      if (field.name === "viewer") {
        const v = store.viewer;
        return { __typename: "Viewer", login: v.login, id: v.id, name: v.name, email: v.email, url: v.login } as GqlObject;
      }
      if (field.name === "repository") {
        const owner = String(args.owner ?? "");
        const name = String(args.name ?? "");
        const repo = store.getRepo(owner, name);
        return repo ? repoObj(store, repo) : null;
      }
      if (field.name === "node") {
        const parsed = store.parseGlobalId(String(args.id ?? ""));
        if (!parsed) return null;
        if (parsed.kind === "Repository") {
          const repo = repoById(store, Number(parsed.parts[0]));
          return repo ? repoObj(store, repo) : null;
        }
        if (parsed.kind === "Issue") {
          const repo = repoById(store, Number(parsed.parts[0]));
          const issue = repo?.issues.get(Number(parsed.parts[1]));
          return repo && issue ? issueObj(store, repo, issue) : null;
        }
        if (parsed.kind === "PullRequest") {
          const repo = repoById(store, Number(parsed.parts[0]));
          const pr = repo?.prs.get(Number(parsed.parts[1]));
          return repo && pr ? prObj(store, repo, pr) : null;
        }
        return null;
      }
      if (field.name === "__type") {
        const name = String(args.name ?? "");
        if (name === "SearchType") {
          return {
            __typename: "__Type", name, kind: "ENUM",
            enumValues: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "CODE", "TOPIC", "LABEL", "MILESTONE", "PACKAGE", "WIKI"].map((n) => ({ __typename: "__EnumValue", name: n } as GqlObject)),
          } as GqlObject;
        }
        const fields = INTROSPECTION_FIELDS[name];
        if (!fields) return null;
        return {
          __typename: "__Type", name, kind: "OBJECT",
          fields: fields.map((n) => ({ __typename: "__Field", name: n, description: null } as GqlObject)),
        } as GqlObject;
      }
      if (field.name === "__schema") {
        return { __typename: "__Schema", queryType: { __typename: "__Type", name: "Query" } } as GqlObject;
      }
      return null;
    }
    case "Repository": {
      const repo = obj.__repo as Repo;
      if (field.name === "issue") {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObj(store, repo, issue) : null;
      }
      if (field.name === "issues") {
        let list = [...repo.issues.values()];
        const states = args.states as string[] | undefined;
        if (states && states.length) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((i) => wanted.has(i.state === "open" ? "OPEN" : "CLOSED"));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const dir = String(orderBy?.direction ?? "DESC").toUpperCase();
        list.sort((a, b) => (dir === "ASC" ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
        const nodes = list.map((i) => issueObj(store, repo, i));
        return connection(nodes, args.first as number | undefined, args.after as string | undefined, "IssueConnection", "IssueEdge");
      }
      if (field.name === "pullRequest") {
        const pr = repo.prs.get(Number(args.number));
        return pr ? prObj(store, repo, pr) : null;
      }
      if (field.name === "pullRequests") {
        let list = [...repo.prs.values()];
        const states = args.states as string[] | undefined;
        if (states && states.length) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((p) => wanted.has(p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED"));
        } else {
          list = list.filter((p) => p.state === "open");
        }
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const nodes = list.map((p) => prObj(store, repo, p));
        return connection(nodes, args.first as number | undefined, args.after as string | undefined, "PullRequestConnection", "PullRequestEdge");
      }
      return obj[field.name] ?? null;
    }
    case "PullRequest": {
      const repo = obj.__repo as Repo;
      const pr = obj.__pr as PullRequest;
      if (field.name === "mergeable") {
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
        const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
        const fresh: PullRequest = { ...pr, headSha: headTip, baseSha: baseTip, mergeBase: store.mergeBase(repo, headTip, baseTip) };
        return store.hasConflict(repo, fresh) ? "CONFLICTING" : "MERGEABLE";
      }
      if (field.name === "files") {
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
        const diffs = store.diffFiles(repo, pr.baseSha, headTip);
        const nodes = diffs.map((d) => ({
          __typename: "PullRequestChangedFile", path: d.filename,
          additions: d.additions, deletions: d.deletions,
          changeType: d.status.toUpperCase(),
        } as GqlObject));
        return {
          __typename: "PullRequestChangedFileConnection",
          nodes,
          edges: nodes.map((node) => ({ __typename: "PullRequestChangedFileEdge", node, cursor: cursorFor(0) } as GqlObject)),
          pageInfo: { __typename: "PageInfo", hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } as GqlObject,
          totalCount: nodes.length,
        } as GqlObject;
      }
      return obj[field.name] ?? null;
    }
    case "Mutation": {
      return resolveMutation(field, ctx, doc);
    }
    default:
      return obj[field.name] ?? null;
  }
}

function resolveMutation(field: FieldSelection, ctx: GqlContext, doc: Document): unknown {
  const store = ctx.store;
  const args = argMap(field.args, ctx);
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === "createIssue") {
    const parsed = store.parseGlobalId(String(input.repositoryId ?? ""));
    const repo = parsed?.kind === "Repository" ? repoById(store, Number(parsed.parts[0])) : null;
    if (!repo) {
      ctx.errors.push({ message: "repository not found" });
      return { __typename: "CreateIssuePayload", issue: null } as GqlObject;
    }
    const number = ++repo.counter;
    const createdSeq = store.nextSeq();
    const issue: Issue = {
      number,
      title: String(input.title ?? ""),
      body: String(input.body ?? ""),
      state: "open",
      labels: [],
      comments: [],
      createdSeq,
      createdAt: store.tsForSeq(createdSeq),
      jsonCache: null,
      jsonBase: null,
    };
    repo.issues.set(number, issue);
    return { __typename: "CreateIssuePayload", issue: issueObj(store, repo, issue) } as GqlObject;
  }
  if (field.name === "closeIssue") {
    const parsed = store.parseGlobalId(String(input.issueId ?? ""));
    const repo = parsed?.kind === "Issue" ? repoById(store, Number(parsed.parts[0])) : null;
    const issue = repo?.issues.get(Number(parsed?.parts[1] ?? NaN));
    if (!repo || !issue) {
      ctx.errors.push({ message: "issue not found" });
      return { __typename: "CloseIssuePayload", issue: null } as GqlObject;
    }
    issue.state = "closed";
    issue.jsonCache = null;
    issue.jsonBase = null;
    return { __typename: "CloseIssuePayload", issue: issueObj(store, repo, issue) } as GqlObject;
  }
  if (field.name === "createPullRequest") {
    const parsed = store.parseGlobalId(String(input.repositoryId ?? ""));
    const repo = parsed?.kind === "Repository" ? repoById(store, Number(parsed.parts[0])) : null;
    if (!repo) {
      ctx.errors.push({ message: "repository not found" });
      return { __typename: "CreatePullRequestPayload", pullRequest: null } as GqlObject;
    }
    const headRef = String(input.headRefName ?? "");
    const baseRef = String(input.baseRefName ?? "");
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: "head or base branch does not exist" });
      return { __typename: "CreatePullRequestPayload", pullRequest: null } as GqlObject;
    }
    for (const p of repo.prs.values()) {
      if (p.state === "open" && p.headRef === headRef && p.baseRef === baseRef) {
        return { __typename: "CreatePullRequestPayload", pullRequest: prObj(store, repo, p) } as GqlObject;
      }
    }
    const number = ++repo.counter;
    const pr: PullRequest = {
      number,
      title: String(input.title ?? ""),
      body: String(input.body ?? ""),
      state: "open",
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeBase: store.mergeBase(repo, headSha, baseSha),
      createdSeq: store.nextSeq(),
    };
    repo.prs.set(number, pr);
    return { __typename: "CreatePullRequestPayload", pullRequest: prObj(store, repo, pr) } as GqlObject;
  }
  if (field.name === "mergePullRequest") {
    const parsed = store.parseGlobalId(String(input.pullRequestId ?? ""));
    const repo = parsed?.kind === "PullRequest" ? repoById(store, Number(parsed.parts[0])) : null;
    const pr = repo?.prs.get(Number(parsed?.parts[1] ?? NaN));
    if (!repo || !pr) {
      ctx.errors.push({ message: "pull request not found" });
      return { __typename: "MergePullRequestPayload", pullRequest: null } as GqlObject;
    }
    if (pr.merged) return { __typename: "MergePullRequestPayload", pullRequest: prObj(store, repo, pr) } as GqlObject;
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!headTip || !baseTip) {
      ctx.errors.push({ message: "head or base branch is gone" });
      return { __typename: "MergePullRequestPayload", pullRequest: null } as GqlObject;
    }
    const fresh: PullRequest = { ...pr, headSha: headTip, baseSha: baseTip, mergeBase: store.mergeBase(repo, headTip, baseTip) };
    if (store.hasConflict(repo, fresh)) {
      ctx.errors.push({ message: "merge conflict" });
      return { __typename: "MergePullRequestPayload", pullRequest: null } as GqlObject;
    }
    mergePr(store, repo, pr, headTip, baseTip);
    return { __typename: "MergePullRequestPayload", pullRequest: prObj(store, repo, pr) } as GqlObject;
  }
  if (field.name === "addComment") {
    const parsed = store.parseGlobalId(String(input.subjectId ?? ""));
    const repo = parsed?.kind === "Issue" ? repoById(store, Number(parsed.parts[0])) : null;
    const issue = repo?.issues.get(Number(parsed?.parts[1] ?? NaN));
    if (!repo || !issue) {
      ctx.errors.push({ message: "subject not found" });
      return { __typename: "AddCommentPayload", commentEdge: null } as GqlObject;
    }
    const comment = { id: ++repo.commentId, body: String(input.body ?? "") };
    issue.comments.push(comment);
    issue.jsonCache = null;
    issue.jsonBase = null;
    return {
      __typename: "AddCommentPayload",
      commentEdge: {
        __typename: "IssueCommentEdge",
        node: { __typename: "IssueComment", id: store.globalId("IssueComment", [repo.id, issue.number, comment.id]), body: comment.body } as GqlObject,
        cursor: cursorFor(comment.id),
      } as GqlObject,
    } as GqlObject;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

function mergePr(store: Store, repo: Repo, pr: PullRequest, headTip: string, baseTip: string): string {
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const mergeSha = store.makeCommit(repo, headTree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
  store.setRef(repo, `refs/heads/${pr.baseRef}`, mergeSha);
  pr.state = "closed";
  pr.merged = true;
  pr.mergedAt = store.tick();
  pr.mergeCommitSha = mergeSha;
  return mergeSha;
}

function execSelections(
  typeName: string,
  obj: GqlObject | null,
  selections: Selection[],
  ctx: GqlContext,
  doc: Document,
): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === "field") {
      const known = FIELDS[typeName];
      if (known && !known.has(sel.name)) {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
        continue;
      }
      const value = resolveField(typeName, obj, sel, ctx, doc);
      if (value === null || value === undefined) {
        out[sel.alias ?? sel.name] = null;
      } else if (Array.isArray(value)) {
        // Connection nodes/edges: resolve each element's sub-selections.
        out[sel.alias ?? sel.name] = value.map((el) => {
          if (el && typeof el === "object" && (el as GqlObject).__typename) {
            return execSelections((el as GqlObject).__typename, el as GqlObject, sel.selections, ctx, doc);
          }
          return el;
        });
      } else if (typeof value === "object" && (value as GqlObject).__typename) {
        out[sel.alias ?? sel.name] = execSelections((value as GqlObject).__typename, value as GqlObject, sel.selections, ctx, doc);
      } else {
        out[sel.alias ?? sel.name] = value;
      }
    } else if (sel.kind === "inlineFragment") {
      if (sel.typeCondition && sel.typeCondition !== obj.__typename) continue;
      const inner = execSelections(typeName, obj, sel.selections, ctx, doc);
      if (inner) Object.assign(out, inner);
    } else if (sel.kind === "fragmentSpread") {
      const frag = doc.fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition !== obj.__typename) continue;
      const inner = execSelections(typeName, obj, frag.selections, ctx, doc);
      if (inner) Object.assign(out, inner);
    }
  }
  return out;
}

export interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(
  store: Store,
  baseUrl: string,
  body: unknown,
  operationName?: string,
): GraphQLResponse | GraphQLResponse[] {
  const runOne = (doc: { query?: unknown; variables?: unknown; operationName?: string }): GraphQLResponse => {
    const ctx: GqlContext = {
      store,
      baseUrl,
      vars: (doc.variables as Record<string, unknown>) ?? {},
      errors: [],
    };
    if (typeof doc.query !== "string") {
      return { data: null, errors: [{ message: "query must be a string" }] };
    }
    let parsed: Document;
    try {
      parsed = new Parser(tokenize(doc.query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
    const opName = doc.operationName ?? operationName;
    const op = opName
      ? parsed.operations.find((o) => o.name === opName)
      : parsed.operations[0];
    if (!op) return { data: null, errors: [{ message: `unknown operation ${opName ?? ""}` }] };
    for (const def of op.variableDefinitions) {
      if (!(def.name in ctx.vars) && def.defaultValue) {
        ctx.vars[def.name] = valueOf(def.defaultValue, ctx);
      }
    }
    const rootType = op.type === "mutation" ? "Mutation" : "Query";
    const root: GqlObject = { __typename: rootType };
    const data = execSelections(rootType, root, op.selections, ctx, parsed);
    if (ctx.errors.length) {
      return { data, errors: ctx.errors };
    }
    return { data };
  };
  if (Array.isArray(body)) return body.map((d) => runOne(d as { query?: unknown; variables?: unknown; operationName?: string }));
  return runOne(body as { query?: unknown; variables?: unknown; operationName?: string });
}
