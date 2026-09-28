/** Bundled prompt assets (#706 PR 4).
 *
 * `scripts/default_system_prompt.txt` and `scripts/prompt_fragments/*.txt`
 * are embedded at build time by `scripts/generate-v3-contract.mjs` (the same
 * generator that embeds `contracts/action-v3.yml`), so `dist/index.js` is
 * self-contained: at runtime the cwd is the consumer's checkout, never this
 * repository, and nothing under `scripts/` is read. The texts are embedded
 * byte-for-byte; the bash `$(<file)` trailing-newline strip is applied where
 * v2 applies it (`src/prompt/system-prompt.ts`). The v2 runtime keeps reading
 * the same files, so both runtimes share one source of truth. */

import { DEFAULT_SYSTEM_PROMPT_TEXT, PROMPT_FRAGMENT_TEXTS } from "../../.v3-generated/prompt-assets.generated.js";

export interface PromptAssets {
  /** Raw `default_system_prompt.txt`. */
  readonly defaultSystemPrompt: string;
  /** Raw `prompt_fragments/<name>.txt`, keyed by `<name>`. */
  readonly fragments: Readonly<Record<string, string>>;
}

export const BUNDLED_PROMPT_ASSETS: PromptAssets = {
  defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT_TEXT,
  fragments: PROMPT_FRAGMENT_TEXTS,
};

export class MissingPromptFragmentError extends Error {
  constructor(name: string) {
    super(`prompt fragment not bundled: ${name}.txt`);
    this.name = "MissingPromptFragmentError";
  }
}

/** Raw fragment text. A missing fragment is a build defect (v2's `$(<file)`
 * on a missing file aborts the review under `set -e`), so it throws. */
export function rawFragment(assets: PromptAssets, name: string): string {
  if (!Object.prototype.hasOwnProperty.call(assets.fragments, name)) throw new MissingPromptFragmentError(name);
  return assets.fragments[name]!;
}
