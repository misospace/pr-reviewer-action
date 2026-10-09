import { resolveRepositoryEndpoints } from "./endpoints.js";

export interface CloneCredential {
  readonly cloneUrl: string;
  readonly headerName: "Authorization";
  readonly headerValue: string;
}

/** Build a clone credential for the git HTTP protocol. The token travels
 * ONLY as an HTTP Basic `Authorization` header; it is never embedded in the
 * clone URL. Never throws: returns null on invalid endpoint/repo, or on an
 * empty or CR/LF-bearing token (which would break the header or inject
 * lines into it). */
export function buildCloneCredential(
  endpoint: string,
  repo: string,
  token: string,
  username = "x-access-token"
): CloneCredential | null {
  try {
    const eps = resolveRepositoryEndpoints(endpoint, repo);
    if (eps === null) return null;
    if (token === "" || token.includes("\r") || token.includes("\n")) return null;
    return {
      cloneUrl: eps.cloneUrl,
      headerName: "Authorization",
      headerValue: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
    };
  } catch {
    return null;
  }
}
