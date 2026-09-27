/** Prompt-fragment loading for the fixed specialist roles (v3 port of the
 * loader half of `pr_reviewer/specialists.py`). Fragments are static,
 * repository-committed text assets (`scripts/prompt_fragments/specialist_*.txt`)
 * shared with the v2 runtime; reading them is not "running Python" — they are
 * plain data files, and other v3 prompt-assembly ports read the same
 * directory. Resolution anchors on the repository root (`process.cwd()`,
 * matching the convention `src/context/repo-map.ts` and `src/context/fixture.ts`
 * already use for workspace-root resolution), not on the compiled bundle's
 * own location, so it works identically from `dist/index.js` (bundled) and
 * from the unbundled test build. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { SPECIALIST_ROLES } from "./types.js";

export class UnknownSpecialistRoleError extends Error {
  constructor(role: string) {
    super(`unknown specialist role: '${role}'; expected one of [correctness, security, tests]`);
    this.name = "UnknownSpecialistRoleError";
  }
}

/** `variant` (#758 adversarial-correctness arm) selects
 * `specialist_<role>_<variant>.txt`; an empty variant keeps the default
 * `specialist_<role>.txt`. */
export function promptFragmentPath(role: string, repoRoot: string = process.cwd(), variant = ""): string {
  if (!SPECIALIST_ROLES.has(role)) {
    throw new UnknownSpecialistRoleError(role);
  }
  const name = variant ? `specialist_${role}_${variant}.txt` : `specialist_${role}.txt`;
  return path.join(repoRoot, "scripts", "prompt_fragments", name);
}

export function loadSpecialistPrompt(role: string, repoRoot: string = process.cwd(), variant = ""): string {
  return readFileSync(promptFragmentPath(role, repoRoot, variant), "utf8");
}
