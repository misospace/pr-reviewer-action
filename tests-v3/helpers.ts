import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";

export interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockServer {
  url: string;
  requests: CapturedRequest[];
  /** Handler exceptions, kept local to the test process — never sent to the client. */
  handlerErrors: unknown[];
  close(): Promise<void>;
}

export function startMockServer(handler: (req: IncomingMessage, body: string, res: http.ServerResponse) => void | Promise<void>): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const handlerErrors: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ headers: req.headers, body });
      try {
        await handler(req, body, res);
      } catch (error) {
        // CodeQL js/stack-trace-exposure: the exception (which may carry a
        // stack or other diagnostic detail) stays in this process — a test
        // can inspect `handlerErrors` — and the client only ever sees a
        // fixed, constant body.
        handlerErrors.push(error);
        res.statusCode = 500;
        res.end("internal test helper error");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        handlerErrors,
        close: () => new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        }),
      });
    });
  });
}

export function sseResponse(events: string[], options: { status?: number; delayMs?: number } = {}): (req: IncomingMessage, body: string, res: http.ServerResponse) => void {
  return (_req, _body, res) => {
    res.statusCode = options.status ?? 200;
    res.setHeader("Content-Type", "text/event-stream");
    let index = 0;
    const writeNext = (): void => {
      if (index >= events.length) {
        res.end();
        return;
      }
      const event = events[index++];
      const write = (): void => {
        res.write(`${event}\n`);
        writeNext();
      };
      if (options.delayMs && index > 1) {
        setTimeout(write, options.delayMs);
        return;
      }
      write();
    };
    writeNext();
  };
}
