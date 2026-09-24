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
  close(): Promise<void>;
}

export function startMockServer(handler: (req: IncomingMessage, body: string, res: http.ServerResponse) => void | Promise<void>): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ headers: req.headers, body });
      try {
        await handler(req, body, res);
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
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
