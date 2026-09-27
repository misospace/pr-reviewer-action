/** CPython `urllib.parse` / `urllib.request` URL splitting, for the
 * linked-source fetch port (#706 PR 5b). v2 gates, renders and connects on
 * the hostname Python extracts, which differs from WHATWG `new URL()` on
 * hostile input (backslashes, userinfo, percent-encoded hosts, IDN). The
 * fetch never guesses: it connects only when Python's view of the URL is
 * unambiguous, and otherwise fails closed. */

import { parseIpLiteral } from "./ip-policy.js";

/** A `ValueError` urllib raises; v2's caller propagates it (the render
 * aborts), so the port throws too. */
export class PyUrlValueError extends Error {
  constructor(message: string) {
    super(`ValueError: ${message}`);
    this.name = "PyUrlValueError";
  }
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

function partition(text: string, sep: string): [string, string, string] {
  const index = text.indexOf(sep);
  return index === -1 ? [text, "", ""] : [text.slice(0, index), sep, text.slice(index + sep.length)];
}

function rpartition(text: string, sep: string): [string, string, string] {
  const index = text.lastIndexOf(sep);
  return index === -1 ? ["", "", text] : [text.slice(0, index), sep, text.slice(index + sep.length)];
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\.[\s\S]+$/.test(hostname)) throw new PyUrlValueError("IPvFuture address is invalid");
    return;
  }
  const literal = parseIpLiteral(hostname);
  if (literal === null) throw new PyUrlValueError(`'${hostname}' does not appear to be an IPv4 or IPv6 address`);
  if (literal.family === 4) throw new PyUrlValueError("An IPv4 address cannot be in brackets");
}

function checkBracketedNetloc(netloc: string): void {
  const hostAndPort = rpartition(netloc, "@")[2];
  const [before, open, bracketed] = partition(hostAndPort, "[");
  let hostname: string;
  if (open) {
    if (before) throw new PyUrlValueError("Invalid IPv6 URL");
    const [host, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw new PyUrlValueError("Invalid IPv6 URL");
    hostname = host;
  } else {
    hostname = partition(hostAndPort, ":")[0];
  }
  checkBracketedHost(hostname);
}

function checkNetloc(netloc: string): void {
  // eslint-disable-next-line no-control-regex
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replaceAll("@", "").replaceAll(":", "").replaceAll("#", "").replaceAll("?", "");
  const normalized = n.normalize("NFKC");
  if (n === normalized) return;
  for (const ch of "/?#@:") {
    if (normalized.includes(ch)) {
      throw new PyUrlValueError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
    }
  }
}

export interface PySplitResult {
  scheme: string;
  netloc: string;
}

/** `urllib.parse.urlsplit(url)` — the scheme and netloc (with its
 * ValueError checks); path/query/fragment are not needed by the callers. */
export function pyUrlsplit(input: string): PySplitResult {
  // eslint-disable-next-line no-control-regex
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  let netloc = "";
  if (url.startsWith("//")) {
    let delim = url.length;
    for (const ch of "/?#") {
      const index = url.indexOf(ch, 2);
      if (index >= 0) delim = Math.min(delim, index);
    }
    netloc = url.slice(2, delim);
    const hasOpen = netloc.includes("[");
    const hasClose = netloc.includes("]");
    if (hasOpen !== hasClose) throw new PyUrlValueError("Invalid IPv6 URL");
    if (hasOpen && hasClose) checkBracketedNetloc(netloc);
  }
  checkNetloc(netloc);
  return { scheme, netloc };
}

/** `urlparse(url).hostname`: lowercased (zone id preserved), or null. */
export function pyUrlHostname(url: string): string | null {
  const { netloc } = pyUrlsplit(url);
  const hostinfo = rpartition(netloc, "@")[2];
  const [, open, bracketed] = partition(hostinfo, "[");
  const hostname = open ? partition(bracketed, "]")[0] : partition(hostinfo, ":")[0];
  if (!hostname) return null;
  const [host, percent, zone] = partition(hostname, "%");
  return host.toLowerCase() + percent + zone;
}

/** `_extract_host(url)` / `_url_host(url)`: `(urlparse(url).hostname or "").lower()`. */
export function pyUrlHost(url: string): string {
  return (pyUrlHostname(url) ?? "").toLowerCase();
}

export interface PyRequestTarget {
  /** `Request.full_url`: the URL without its last `#fragment`. */
  fullUrl: string;
  scheme: string;
  /** The host urllib connects to (brackets stripped). */
  host: string;
  port: number | null;
  /** The request-line target (`selector`, "/" when empty). */
  path: string;
}

/** How `urllib.request.Request` + `http.client` turn a URL into a
 * connection target: `_splittag` (LAST `#`), `_splittype`, `_splithost`,
 * `unquote(host)` and `_get_hostport`. Returns null wherever urllib/http.client
 * would raise (userinfo in the host, a non-numeric port, a request target
 * with control, space or non-ASCII characters). */
export function pyRequestTarget(url: string): PyRequestTarget | null {
  const [head, hash] = rpartition(url, "#");
  const fullUrl = hash ? head : url;
  const typed = /^([^/:]+):([\s\S]*)$/.exec(fullUrl);
  if (!typed) return null;
  const scheme = typed[1]!.toLowerCase();
  const hosted = /^\/\/([^/#?]*)([\s\S]*)$/.exec(typed[2]!);
  if (!hosted) return null;
  let host: string;
  try {
    host = decodeURIComponent(hosted[1]!);
  } catch {
    return null;
  }
  if (host.includes("@")) return null;
  let port: number | null = null;
  const colon = host.lastIndexOf(":");
  const bracket = host.lastIndexOf("]");
  if (colon > bracket) {
    const portText = host.slice(colon + 1);
    if (portText !== "") {
      if (!/^\d+$/.test(portText)) return null;
      port = Number(portText);
      if (port > 65535) return null;
    }
    host = host.slice(0, colon);
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "") return null;
  const path = hosted[2] || "/";
  if (!/^[\x21-\x7e]+$/.test(path)) return null;
  return { fullUrl, scheme, host, port, path };
}
