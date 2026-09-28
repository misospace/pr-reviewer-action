/** Prompt-fragment loading for the fixed specialist roles (v3 port of the
 * loader half of `pr_reviewer/specialists.py`). Fragments are static,
 * repository-committed text assets shared with the v2 runtime, embedded into
 * the bundle at build time (#804/#809) — the shipped runtime never reads
 * `scripts/prompt_fragments/` from disk, because at runtime the working
 * directory is the *reviewed* checkout, which does not contain them. The
 * generator (scripts/generate-v3-contract.mjs) embeds every fragment
 * verbatim, so the embedded text is byte-identical to the v2 file. */

import { BUNDLED_PROMPT_ASSETS, rawFragment } from "../prompt/assets.js";
import { SPECIALIST_ROLES } from "./types.js";

export class UnknownSpecialistRoleError extends Error {
  constructor(role: string) {
    super(`unknown specialist role: '${role}'; expected one of [correctness, security, tests]`);
    this.name = "UnknownSpecialistRoleError";
  }
}

/** `variant` (#758 adversarial-correctness arm) selects
 * `specialist_<role>_<variant>`; an empty variant keeps the default
 * `specialist_<role>`. Keys match the generator's fragment map (file names
 * without the `.txt` suffix). */
export function specialistFragmentName(role: string, variant = ""): string {
  if (!SPECIALIST_ROLES.has(role)) {
    throw new UnknownSpecialistRoleError(role);
  }
  return variant ? `specialist_${role}_${variant}` : `specialist_${role}`;
}

export function loadSpecialistPrompt(role: string, variant = ""): string {
  return rawFragment(BUNDLED_PROMPT_ASSETS, specialistFragmentName(role, variant));
}
