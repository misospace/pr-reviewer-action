/** Fetch helpers shared by the fixture-driven v3 tests (#706 PR 1).
 *
 * `routeFetch` serves raw forge responses (GitHub REST/GraphQL, Forgejo
 * /api/v1) from a route table and logs every request; `asciiJson` renders a
 * value as order-preserving ASCII JSON
 * (`json.dumps(..., ensure_ascii=True, separators=(",", ":"))`) so key order,
 * element order and every string byte are comparable. Both are consumed by
 * `src/context/linked-sources-fixture.ts`. */

import type { FetchLike } from "./http.js";

interface Route {
  match: string;
  status?: number;
  body?: unknown;
  raw?: string;
  pages?: unknown[];
  hang?: boolean;
}

/** `json.dumps(value, ensure_ascii=True, separators=(",", ":"))` with
 * insertion order kept. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : record[key];
}

function relative(url: URL): string {
  return url.href.slice(url.origin.length + 1);
}

/** A fetch serving the fixture route table and logging every request. */
export function routeFetch(routes: readonly Route[], log: string[]): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = headerValue(init, "Authorization") ? 1 : 0;
    let key: string;
    if (method === "POST" && url.pathname.endsWith("/graphql")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      key = (body.query ?? "").includes("reviewThreads") ? "graphql:reviewThreads" : "graphql:comments";
      log.push(`POST ${url.origin}${url.pathname} auth=${auth} ${sortedJson(body)}`);
    } else {
      key = relative(url);
      log.push(`${method} ${url.href} auth=${auth}`);
    }
    const stripped = new URL(url.href);
    stripped.searchParams.delete("per_page");
    stripped.searchParams.delete("page");
    const strippedKey = relative(stripped).replace(/\?$/, "");
    const route = routes.find((r) => r.match === key || r.match === url.href || (r.pages !== undefined && r.match === strippedKey));
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if (route.hang) {
      // A hung server: settle only when the caller's signal aborts. The
      // AbortSignal.timeout timer is unref'd (a real socket keeps the loop
      // alive), so hold a ref'd timer until then.
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const keepAlive = setTimeout(() => reject(new Error("fixture hang exceeded 120s")), 120_000);
        const abort = (): void => {
          clearTimeout(keepAlive);
          reject(signal?.reason);
        };
        if (!signal) return;
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    const status = route.status ?? 200;
    if (route.pages !== undefined) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const headers: Record<string, string> = {};
      if (page < route.pages.length) {
        headers.Link = `<${url.origin}/${route.match}?per_page=100&page=${page + 1}>; rel="next"`;
      }
      return new Response(JSON.stringify(route.pages[page - 1] ?? []), { status, headers });
    }
    const text = route.raw !== undefined ? route.raw : JSON.stringify(route.body ?? null);
    return new Response(text, { status });
  };
}
