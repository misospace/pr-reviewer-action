/** The requirement-ledger's content-id recipe, shared with intake (#1750).
 *
 * The umbrella-decomposition ownership channel (#1750) renders
 * `(decomposition: req-<id> -> <child refs>)` metadata lines into
 * `linked-issues.md` at intake, where `<id>` is the id the requirement ledger
 * will derive for the criterion line. The ledger attaches the child refs to
 * exactly the entry whose content id matches — so issue content never
 * appears outside the JSON fence in `linked-issues.md` (the exact-match trust
 * model for metadata lines is preserved), and a metadata line can only ever
 * affect the one entry its id names.
 *
 * Both sides therefore share BOTH steps of the recipe as one module:
 * `normalizeRequirementText` (the whitespace squeeze + visible truncation the
 * ledger scanner applies to every extracted line) and `requirementIdOfText`
 * (the `req-` + sha256(casefolded post-truncation text)[:12] content id). A
 * normalization or id drift between intake and the ledger would silently
 * detach associations — which fails CLOSED downstream (the criterion stays in
 * scope), never unsafe.
 */

import { createHash } from "node:crypto";

/** Hard text cap per ledger entry (defaults per #624) — mirrored here because
 * the id is the id of exactly the post-truncation text a reader can see. */
export const MAX_REQUIREMENT_TEXT_CHARS = 400;

const TRUNCATION_MARKER = "…";
const WS_RE = /\s+/g;

/** Normalize one already-marker-stripped line the way the ledger scanner
 * does: collapse every whitespace run to a single space, trim, and truncate
 * over-long text with a visible `…` marker. `null` when nothing survives. */
export function normalizeRequirementText(raw: string): { text: string; truncated: boolean } | null {
  const text = raw.replace(WS_RE, " ").trim();
  if (!text) return null;
  if (text.length > MAX_REQUIREMENT_TEXT_CHARS) {
    return { text: text.slice(0, MAX_REQUIREMENT_TEXT_CHARS - 1) + TRUNCATION_MARKER, truncated: true };
  }
  return { text, truncated: false };
}

/** The content-derived requirement id: `req-` + first 12 hex of sha256 over
 * the casefolded post-truncation text. The id of exactly the text a reader
 * can see. */
export function requirementIdOfText(text: string): string {
  return "req-" + createHash("sha256").update(Buffer.from(text.toLowerCase(), "utf8")).digest("hex").slice(0, 12);
}

/** Shape of a well-formed requirement id (the metadata-line grammar). */
export const REQUIREMENT_ID_PATTERN = /^req-[0-9a-f]{12}$/;
