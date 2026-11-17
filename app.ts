// HTTP server: routing, auth, request ids. The entrypoint main.ts calls
// createApp(), binds an ephemeral port and registers with the suite.
//
// v2 performance notes (behaviour unchanged from v1):
// - no `new URL()` per request: the path is sliced out of req.url by hand
//   and a query string is parsed only when one is present.
// - routing tests cheap string prefixes before any other work; the git
//   path is split by hand instead of a regular expression, and the regex
//   never runs for /api/* requests.
// - auth is a startsWith + slice + === comparison, no regex.
// - JSON replies carry an explicit content-length (no chunked encoding)
//   and handlers may hand back a pre-serialized body to skip stringify.

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

/** A shared, never-mutated empty query bag for requests without `?`. */
const EMPTY_QUERY = new URLSearchParams();

export function createApp(): http.Server {
  const store = new Store();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? "";
  let requestCounter = 0;

  function checkAuth(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    if (shopToken !== "") return token === shopToken;
    return token.length > 0;
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
      "content-length": Buffer.byteLength(payload),
      "X-GitHub-Request-Id": `req-${++requestCounter}`,
      ...extraHeaders,
    });
    res.end(payload);
  }

  /** Send an already-serialized JSON body (no second stringify). */
  function sendRawJson(res: http.ServerResponse, status: number, payload: string, extraHeaders: Record<string, string> = {}): void {
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
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
      const rawUrl = req.url ?? "/";
      const q = rawUrl.indexOf("?");
      const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
      const query = q < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(q + 1));
      const host = req.headers.host ?? "127.0.0.1";
      const baseUrl = `http://${host}`;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- REST v3 (the hottest surface: route it first) ----
      if (path === "/api/v3" || path.startsWith("/api/v3/")) {
        const needsAuth = !(method === "GET" && (path === "/api/v3" || path === "/api/v3/" || path === "/api/v3/meta"));
        if (needsAuth && !checkAuth(req)) {
          sendJson(res, 401, { message: "Requires authentication" });
          return;
        }
        const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
        const parts = path.replace(/^\/api\/v3\/?/, "").split("/").filter((p) => p !== "");
        const out = handleRest(store, { method, parts, query, body, baseUrl });
        if (out.status === 204) {
          res.writeHead(204, { "X-GitHub-Request-Id": `req-${++requestCounter}` });
          res.end();
          return;
        }
        if (out.rawBody !== undefined) {
          sendRawJson(res, out.status, out.rawBody, { "X-Oauth-Scopes": "repo, read:org", ...(out.headers ?? {}) });
          return;
        }
        sendJson(res, out.status, out.body, { "X-Oauth-Scopes": "repo, read:org", ...(out.headers ?? {}) });
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

      // ---- git smart HTTP: /{owner}/{repo}.git[/sub] ----
      const segs = path.split("/");
      // segs: ["", owner, "repo.git", ...sub]
      if (segs.length >= 3 && segs[2] !== undefined && segs[2].endsWith(".git")) {
        const owner = segs[1] ?? "";
        const repoName = segs[2].slice(0, -4);
        if (owner === "" || repoName === "") {
          sendJson(res, 404, { message: "Not Found" });
          return;
        }
        const sub = segs.slice(3).join("/");
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
          const qs = q < 0 ? "" : rawUrl.slice(q + 1);
          if (qs.includes("service=git-upload-pack")) {
            const isV2 = (req.headers["git-protocol"] ?? "") === "version=2";
            const adv = isV2 ? v2Advertisement() : v0UploadAdvertisement(repo);
            sendBuffer(res, 200, adv, "application/x-git-upload-pack-advertisement");
            return;
          }
          if (qs.includes("service=git-receive-pack")) {
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
