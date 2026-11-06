/** Shared bounded request-body reader for the controller HTTP hosts (#737,
 * #1349). One implementation, two consumers: the admin host and the operator
 * MCP host mount on the same listener family and must not drift in how they
 * bound an inbound body. The reader enforces the caller's byte cap while
 * streaming: the moment the running total would exceed the cap the body is
 * discarded and the request is resumed to drain — a partial document is
 * never returned, so an oversized payload can never reach a JSON parser.
 */
import type { IncomingMessage } from "node:http";

export interface BoundedBody {
  readonly body: Buffer | null;
  readonly tooLarge: boolean;
}

export function readBoundedBody(request: IncomingMessage, cap: number): Promise<BoundedBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > cap) {
        settled = true;
        chunks.length = 0;
        resolve({ body: null, tooLarge: true });
        request.resume();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => { if (!settled) { settled = true; resolve({ body: Buffer.concat(chunks), tooLarge: false }); } });
    request.on("error", () => { if (!settled) { settled = true; reject(new Error("request body failure")); } });
  });
}
