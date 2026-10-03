/** Public-address policy for the SSRF-safe linked-source fetch (#706 PR 5b).
 *
 * Port of `pr_reviewer.enrichment._is_public_ip`, which rejects any address
 * CPython's `ipaddress` classifies as loopback, link-local, private,
 * multicast, reserved or unspecified. Under CPython 3.14 that is exactly the
 * `V2_*` tables below (the private networks minus their exceptions, plus the
 * reserved/loopback/link-local/multicast/unspecified ranges); an IPv4-mapped
 * IPv6 address (`::ffff:a.b.c.d`) is classified by its embedded IPv4 address,
 * as CPython does.
 *
 * Approved divergences (v3 blocks, v2 allowed), documented in
 * docs/v3-migration.md:
 * - `100.64.0.0/10` (CGNAT shared address space): CPython's `is_private` is
 *   deliberately False for it, and it is not reserved, so v2 fetched it.
 * - `fec0::/10` (deprecated IPv6 site-local): not in any CPython table. */

export type IpFamily = 4 | 6;

interface Cidr4 {
  base: number;
  bits: number;
}

interface Cidr6 {
  base: bigint;
  bits: number;
}

function cidr4(text: string): Cidr4 {
  const [addr, bits] = text.split("/");
  const base = parseIPv4(addr!);
  if (base === null) throw new Error(`bad IPv4 CIDR ${text}`);
  return { base, bits: Number(bits ?? 32) };
}

function cidr6(text: string): Cidr6 {
  const [addr, bits] = text.split("/");
  const base = parseIPv6(addr!);
  if (base === null) throw new Error(`bad IPv6 CIDR ${text}`);
  return { base, bits: Number(bits ?? 128) };
}

/** CPython 3.14 `_IPv4Constants._private_networks`. */
export const V2_PRIVATE_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.0.170/31",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "240.0.0.0/4",
  "255.255.255.255/32",
] as const;

/** `_private_networks_exceptions`: globally reachable despite 192.0.0.0/24. */
export const V2_PRIVATE_IPV4_EXCEPTIONS = ["192.0.0.9/32", "192.0.0.10/32"] as const;

/** Loopback, link-local, multicast, reserved and unspecified. */
export const V2_BLOCKED_IPV4 = ["127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4", "0.0.0.0/32"] as const;

/** v3 addition (deliberate divergence): CGNAT shared address space. */
export const V3_EXTRA_BLOCKED_IPV4 = ["100.64.0.0/10"] as const;

/** CPython 3.14 `_IPv6Constants` private networks (`::ffff:0:0/96` is
 * classified by the embedded IPv4 address instead). */
export const V2_PRIVATE_IPV6 = [
  "::1/128",
  "::/128",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
] as const;

export const V2_PRIVATE_IPV6_EXCEPTIONS = [
  "2001:1::1/128",
  "2001:1::2/128",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:20::/28",
  "2001:30::/28",
] as const;

/** Link-local, multicast and `_reserved_networks` (everything outside
 * 2000::/3 and fc00::/7 except the ranges listed separately). */
export const V2_BLOCKED_IPV6 = [
  "fe80::/10",
  "ff00::/8",
  "::/8",
  "100::/8",
  "200::/7",
  "400::/6",
  "800::/5",
  "1000::/4",
  "4000::/3",
  "6000::/3",
  "8000::/3",
  "a000::/3",
  "c000::/3",
  "e000::/4",
  "f000::/5",
  "f800::/6",
  "fe00::/9",
] as const;

/** v3 addition (deliberate divergence): deprecated site-local. */
export const V3_EXTRA_BLOCKED_IPV6 = ["fec0::/10"] as const;

const PRIVATE4 = V2_PRIVATE_IPV4.map(cidr4);
const EXCEPT4 = V2_PRIVATE_IPV4_EXCEPTIONS.map(cidr4);
const BLOCKED4 = [...V2_BLOCKED_IPV4, ...V3_EXTRA_BLOCKED_IPV4].map(cidr4);
const PRIVATE6 = V2_PRIVATE_IPV6.map(cidr6);
const EXCEPT6 = V2_PRIVATE_IPV6_EXCEPTIONS.map(cidr6);
const BLOCKED6 = [...V2_BLOCKED_IPV6, ...V3_EXTRA_BLOCKED_IPV6].map(cidr6);

function in4(ip: number, net: Cidr4): boolean {
  if (net.bits === 0) return true;
  const shift = 32 - net.bits;
  return ip >>> shift === net.base >>> shift;
}

function in6(ip: bigint, net: Cidr6): boolean {
  const shift = BigInt(128 - net.bits);
  return ip >> shift === net.base >> shift;
}

/** Strict dotted-quad IPv4 (CPython `IPv4Address`: four decimal octets,
 * no leading zeros). */
export function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** IPv6 text (optional `%zone`, optional embedded IPv4 tail) to a 128-bit
 * integer; null when malformed. */
export function parseIPv6(text: string): bigint | null {
  let addr = text;
  const zone = addr.indexOf("%");
  if (zone !== -1) {
    if (zone === addr.length - 1 || addr.includes("%", zone + 1)) return null;
    addr = addr.slice(0, zone);
  }
  if (!/^[0-9A-Fa-f:.]+$/.test(addr)) return null;
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4 = parseIPv4(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    addr = `${addr.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    return groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g)) ? groups : null;
  };
  const head = groupsOf(halves[0]!);
  if (head === null) return null;
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const tail = groupsOf(halves[1]!);
    if (tail === null || head.length + tail.length > 7) return null;
    groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  }
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

/** Classify a literal IP address; null when `text` is not an IP literal. */
export function parseIpLiteral(text: string): { family: IpFamily; v4?: number; v6?: bigint } | null {
  const v4 = parseIPv4(text);
  if (v4 !== null) return { family: 4, v4 };
  const v6 = parseIPv6(text);
  if (v6 !== null) return { family: 6, v6 };
  return null;
}

function ipv4Blocked(ip: number): boolean {
  if (BLOCKED4.some((net) => in4(ip, net))) return true;
  return PRIVATE4.some((net) => in4(ip, net)) && !EXCEPT4.some((net) => in4(ip, net));
}

function ipv6Blocked(ip: bigint): boolean {
  // IPv4-mapped (::ffff:0:0/96): classified by the embedded IPv4 address.
  if (ip >> 32n === 0xffffn) return ipv4Blocked(Number(ip & 0xffffffffn));
  if (BLOCKED6.some((net) => in6(ip, net))) return true;
  return PRIVATE6.some((net) => in6(ip, net)) && !EXCEPT6.some((net) => in6(ip, net));
}

/** True only for addresses safe to fetch from (`_is_public_ip` plus the v3
 * additions). Anything unparseable is not public (fail closed). */
export function isPublicAddress(text: string): boolean {
  const parsed = parseIpLiteral(text);
  if (parsed === null) return false;
  return parsed.family === 4 ? !ipv4Blocked(parsed.v4!) : !ipv6Blocked(parsed.v6!);
}
