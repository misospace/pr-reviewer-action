/** Shared types and deterministic caps for the deep-review specialist
 * runtime (#776 port of `pr_reviewer/specialists.py` and
 * `scripts/run_specialists.py`).
 *
 * A "specialist" is one of three fixed, narrow-lane reviewers (`correctness`,
 * `security`, `tests`) that inspects the same PR corpus and reports *leads* —
 * advisory signals that require a final verification pass — rather than a
 * final approve/request-changes verdict. Every result carries `version: 1`
 * and the identical `leads` / `truncation` / `errors` shape regardless of
 * role, so a single downstream consumer can read any specialist. Severity is
 * capped below a blocker: a specialist can never itself set `has_blocker` or
 * flip the final verdict. */

export const ARTIFACT_VERSION = 1;

/** Canonical ordered list of fixed specialist roles. The list is the source
 * of truth for iteration order; there is deliberately no extension point —
 * user-defined custom specialist prompts are a non-goal. */
export const SPECIALIST_ROLES_ORDER: readonly string[] = ["correctness", "security", "tests"];

/** Closed set of fixed specialist roles (membership-only). */
export const SPECIALIST_ROLES: ReadonlySet<string> = new Set(SPECIALIST_ROLES_ORDER);

/** The only severities a specialist lead may carry. `blocker` is
 * intentionally absent so a specialist can never set the blocker flag on its
 * own; the main reviewer assigns blocker severity after its own
 * verification. */
export const SPECIALIST_SEVERITIES: readonly string[] = ["major", "minor", "info"];

/** The highest severity a specialist lead is allowed to reach. */
export const MAX_SPECIALIST_SEVERITY = "major";

/** Maps raw model-emitted severity labels onto `SPECIALIST_SEVERITIES`.
 * `blocker` / `critical` deliberately land on `major` (the cap), never on a
 * blocker. Anything unmapped degrades to the least-severe level, `info`. */
export const SEVERITY_ALIASES: Readonly<Record<string, string>> = {
  blocker: MAX_SPECIALIST_SEVERITY,
  critical: MAX_SPECIALIST_SEVERITY,
  major: "major",
  high: "major",
  error: "major",
  minor: "minor",
  medium: "minor",
  low: "minor",
  warning: "minor",
  info: "info",
  note: "info",
  nit: "info",
  suggestion: "info",
};

// Deterministic caps (defaults per #607).
export const MAX_LEADS = 50;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_CATEGORY_CHARS = 64;
export const MAX_FILE_CHARS = 512;
export const MAX_ERRORS = 100;
export const MAX_INPUT_BYTES = 1_000_000;

/** Default completion-token cap for one specialist role call (#632). A
 * conservative allowance for the short structured advisory JSON a specialist
 * returns, deliberately independent of the final reviewer's `ai_max_tokens`. */
export const DEFAULT_SPECIALIST_MAX_TOKENS = 4096;

/** Largest markdown fence (in backticks) the renderer will emit; longer
 * hostile runs are neutralized so the fence stays closed. */
export const MAX_FENCE = 12;

export const ERRORS_TRUNCATED_MARKER = "errors_truncated";

export interface SpecialistLead {
  severity: string;
  category: string;
  file: string | null;
  line: number | null;
  message: string;
}

export interface SpecialistTruncation {
  truncated: boolean;
  reasons: string[];
  omitted_leads: number;
  omitted_message_chars: number;
  omitted_errors: number;
}

export interface SpecialistArtifact {
  version: number;
  role: string;
  leads: SpecialistLead[];
  truncated: boolean;
  truncation: SpecialistTruncation;
  errors: string[];
}
