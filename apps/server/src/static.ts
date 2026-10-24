import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Single-process mode (one container, no nginx): serves the built web app from `dir` and leaves
 * the API under /api, so the browser sees the same paths it gets behind nginx in the cluster.
 * Unknown paths fall back to index.html for client-side routing; /api/metrics stays private.
 */
export function serveWebApp(app: FastifyInstance, dir: string): void {
  const root = resolve(dir);
  const index = join(root, "index.html");

  app.addHook("onRequest", async (req, reply) => {
    if (pathOf(req) === "/api/metrics") return reply.code(404).send({ error: "Not found" });
  });

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    let path: string;
    try {
      path = decodeURIComponent(pathOf(req));
    } catch {
      return reply.code(400).send({ error: "Bad path" });
    }
    if (path === "/api" || path.startsWith("/api/") || path === "/ws") {
      return reply.code(404).send({ error: "Not found" });
    }

    // resolve() collapses any ../ segments; anything that lands outside root serves index.html.
    const candidate = resolve(root, `.${path}`);
    let target = index;
    if (candidate.startsWith(root + sep)) {
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) target = candidate;
    }

    const hashed = target.startsWith(join(root, "assets") + sep);
    return reply
      .type(TYPES[extname(target)] ?? "application/octet-stream")
      .header("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache")
      .send(await readFile(target));
  };

  app.get("/", handler);
  app.get("/*", handler);
}

function pathOf(req: FastifyRequest): string {
  return (req.raw.url ?? "/").split("?")[0] ?? "/";
}
