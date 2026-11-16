// HTTP server: routing, auth, request ids. The entrypoint main.ts calls
// createApp(), binds an ephemeral port and registers with the suite.
import http from "node:http";
import { Store } from "./store.ts";
import { handleRest } from "./rest.ts";
import { executeGraphQL } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import {
  v0UploadAdvertisement,
  v0ReceiveAdvertisement,
  v2Advertisement,
  lsRefs,
  parseFetchBody,
  parseLsRefsBody,
  fetchV2Response,
  fetchV0Response,
  receivePack,
  receivePackResponse,
} from "./git.ts";

const MAX_BODY_BYTES = 128 * 1024 * 1024;

export function createApp(): http.Server {
  const store = new Store();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? "";
  let requestCounter = 0;

  function checkAuth(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const m = header.match(/^Bearer (.+)$/);
    if (!m) return false;
    if (shopToken !== "") return m[1] === shopToken;
    return m[1].length > 0;
  }

  function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const payload = body === null ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "X-GitHub-Request-Id": `req-${++requestCounter}`,
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sendBuffer(res: http.ServerResponse, status: number, body: Buffer, contentType: string): void {
    res.writeHead(status, { "content-type": contentType, "content-length": body.length });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const baseUrl = `http://${req.headers.host ?? "127.0.0.1"}`;
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- git smart HTTP ----
      const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/);
      if (gitMatch) {
        const [, owner, repoName, sub = ""] = gitMatch;
        if (!checkAuth(req)) {
          sendJson(res, 401, { message: "Requires authentication" });
          return;
        }
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendJson(res, 404, { message: "Not Found" });
          return;
        }
        if (method === "GET" && sub === "info/refs") {
          const service = url.searchParams.get("service");
          if (service === "git-upload-pack") {
            const isV2 = (req.headers["git-protocol"] ?? "") === "version=2";
            const adv = isV2 ? v2Advertisement() : v0UploadAdvertisement(repo);
            sendBuffer(res, 200, adv, "application/x-git-upload-pack-advertisement");
            return;
          }
          if (service === "git-receive-pack") {
            sendBuffer(res, 200, v0ReceiveAdvertisement(repo), "application/x-git-receive-pack-advertisement");
            return;
          }
          sendJson(res, 400, { message: "service parameter required" });
          return;
        }
        if (method === "POST" && sub === "git-upload-pack") {
          const body = await readBody(req);
          const isV2 = (req.headers["git-protocol"] ?? "") === "version=2";
          if (isV2) {
            const { req: fetchReq, command, error } = parseFetchBody(body);
            if (error) {
              sendJson(res, 400, { message: error });
              return;
            }
            if (command === "ls-refs") {
              const ls = parseLsRefsBody(body);
              if (ls.error) {
                sendJson(res, 400, { message: ls.error });
                return;
              }
              sendBuffer(res, 200, lsRefs(repo, ls), "application/x-git-upload-pack-result");
              return;
            }
            if (command === "fetch") {
              sendBuffer(res, 200, fetchV2Response(store, repo, fetchReq), "application/x-git-upload-pack-result");
              return;
            }
            sendJson(res, 400, { message: `unknown command ${command}` });
            return;
          }
          const { req: fetchReq, error } = parseFetchBody(body);
          if (error) {
            sendJson(res, 400, { message: error });
            return;
          }
          sendBuffer(res, 200, fetchV0Response(store, repo, fetchReq), "application/x-git-upload-pack-result");
          return;
        }
        if (method === "POST" && sub === "git-receive-pack") {
          const body = await readBody(req);
          const result = receivePack(store, repo, body);
          sendBuffer(res, 200, receivePackResponse(result), "application/x-git-receive-pack-result");
          return;
        }
        sendJson(res, 404, { message: "Not Found" });
        return;
      }

      // ---- GraphQL ----
      if (path === "/api/graphql") {
        if (method !== "POST") {
          sendJson(res, 404, { message: "Not Found" });
          return;
        }
        if (!checkAuth(req)) {
          sendJson(res, 401, { message: "Requires authentication" });
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          sendJson(res, 400, { errors: [{ message: "Invalid JSON body" }] });
          return;
        }
        const out = executeGraphQL(store, baseUrl, parsed);
        sendJson(res, 200, out);
        return;
      }

      // ---- MCP ----
      if (path === "/mcp") {
        if (method === "DELETE") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (method !== "POST") {
          sendJson(res, 404, { message: "Not Found" });
          return;
        }
        const body = await readBody(req);
        const out = handleMcp(store, baseUrl, body, checkAuth(req));
        if (out.body === null) {
          res.writeHead(out.status);
          res.end();
          return;
        }
        sendJson(res, out.status, out.body);
        return;
      }

      // ---- REST v3 ----
      if (path === "/api/v3" || path.startsWith("/api/v3/")) {
        const needsAuth = !(method === "GET" && (path === "/api/v3" || path === "/api/v3/" || path === "/api/v3/meta"));
        if (needsAuth && !checkAuth(req)) {
          sendJson(res, 401, { message: "Requires authentication" });
          return;
        }
        const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
        const parts = path.replace(/^\/api\/v3\/?/, "").split("/").filter((p) => p !== "");
        const out = handleRest(store, { method, parts, query: url.searchParams, body, baseUrl });
        if (out.status === 204) {
          res.writeHead(204, { "X-GitHub-Request-Id": `req-${++requestCounter}` });
          res.end();
          return;
        }
        sendJson(res, out.status, out.body, { "X-Oauth-Scopes": "repo, read:org", ...(out.headers ?? {}) });
        return;
      }

      sendJson(res, 404, { message: "Not Found" });
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: e instanceof Error ? e.message : String(e) });
      } else {
        res.destroy();
      }
    }
  });

  return server;
}
