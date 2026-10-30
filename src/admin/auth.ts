/** Fail-closed bearer authentication for the isolated admin surface. */
import { createHash, timingSafeEqual } from "node:crypto";

export class AdminAuthenticator {
  private readonly digest: Buffer | null;

  constructor(token: string | undefined) {
    if (token !== undefined && (typeof token !== "string" || token.trim() === "")) {
      throw new TypeError("admin token must not be empty or whitespace");
    }
    this.digest = token === undefined ? null : createHash("sha256").update(token, "utf8").digest();
  }

  configured(): boolean {
    return this.digest !== null;
  }

  authenticate(header: string | string[] | undefined): boolean {
    if (this.digest === null || typeof header !== "string") return false;
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    if (match === null) return false;
    const candidate = createHash("sha256").update(match[1]!, "utf8").digest();
    return timingSafeEqual(this.digest, candidate);
  }
}
