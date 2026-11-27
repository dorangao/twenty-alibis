import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest, MAX_BODY_BYTES, type ApiDeps } from "./api";

/**
 * The game API behind Node's own http server: the local dev server uses it, and so can any
 * plain Node host. It turns a Node request into a web-standard Request, hands it to
 * `handleRequest`, and writes the Response back. It decides nothing itself.
 */
export function nodeListener(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = req.method ?? "GET";
    // Read no more than the handler would accept, plus one byte so it can tell the body was too long.
    const chunks: Buffer[] = [];
    let size = 0;
    if (method !== "GET" && method !== "HEAD") {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES + 1) chunks.push(chunk);
      }
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    // Behind a proxy that ends TLS, the proxy says which scheme the visitor used.
    const scheme = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const body = size > MAX_BODY_BYTES ? "x".repeat(MAX_BODY_BYTES + 1) : Buffer.concat(chunks).toString("utf8");
    const request = new Request(`${scheme}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body }) });
    const response = await handleRequest(request, deps);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(await response.text());
  };
}
