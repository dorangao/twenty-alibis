import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { handleRequest, type ApiDeps } from "./api";

/**
 * The game API behind Node's own http server: the local dev server uses it, and so can any
 * plain Node host. It turns a Node request into a web-standard Request, hands it to
 * `handleRequest`, and writes the Response back. It decides nothing itself.
 *
 * The body is not read here. It is given to the handler as a stream that takes from the
 * socket only when the handler asks, so the handler's own order holds: a request from the
 * wrong origin is refused with none of its body read, and a body is read no further than the
 * handler's limit. If the handler answers without having read the whole body, the
 * connection is closed after the answer, and what was still on its way is never taken in.
 *
 * `trustProxy`: only a server that really sits behind a proxy it trusts may believe the
 * "x-forwarded-proto" header. Reached directly, any client can send that header, so by
 * default it is ignored and the scheme is http. A deployed server should also name its public
 * origin in `deps.origin`, which is what the origin check and the cookie's Secure flag go by.
 */
export function nodeListener(deps: ApiDeps, options: { trustProxy?: boolean } = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = req.method ?? "GET";
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const scheme = options.trustProxy && req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const url = `${scheme}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, { method, headers, ...(hasBody ? { body: bodyOf(req), duplex: "half" } : {}) } as RequestInit);

    const response = await handleRequest(request, deps);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    // Part of the body was never read: do not keep this connection for another request.
    if (hasBody && !req.complete) res.setHeader("connection", "close");
    res.end(await response.text());
  };
}

/** The request's body as a stream that reads from the socket one chunk at a time, on demand. */
export function bodyOf(req: Readable): ReadableStream<Uint8Array> {
  req.pause();
  // Once the stream is over, by its end, an error or the reader stopping, it listens to
  // nothing more. Being told twice, or told of the end after the reader has stopped, is harmless.
  let over = false;
  let finish: () => void = () => undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer) => {
        // One chunk per pull: stop the socket until the reader asks again.
        req.pause();
        controller.enqueue(new Uint8Array(chunk));
      };
      const onEnd = () => {
        if (over) return;
        finish();
        controller.close();
      };
      const onError = (error: Error) => {
        if (over) return;
        finish();
        controller.error(error);
      };
      finish = () => {
        over = true;
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
      };
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
    },
    pull() {
      if (!over) req.resume();
    },
    cancel() {
      // The reader has had enough. Take nothing more from the socket.
      req.pause();
      finish();
    },
  });
}
