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

export function promptFragmentPath(role: string, repoRoot: string = process.cwd()): string {
  if (!SPECIALIST_ROLES.has(role)) {
    throw new UnknownSpecialistRoleError(role);
  }
  return path.join(repoRoot, "scripts", "prompt_fragments", `specialist_${role}.txt`);
}

export function loadSpecialistPrompt(role: string, repoRoot: string = process.cwd()): string {
  return readFileSync(promptFragmentPath(role, repoRoot), "utf8");
}
