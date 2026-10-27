/**
 * #1238: the executing action's own deterministic gates.
 *
 * The incident this registry answers: a model claimed the action had no
 * draft/label filtering because the action metadata declares no such
 * input, and the claim survived as a substantiated finding. The metadata
 * cannot decide a behavior-existence claim — only the action's own
 * implementation can. This registry is the bounded set of gates whose
 * implementation the blocker-verification boundary may consult: each entry
 * names the behavior subject it implements and the literal byte sequence
 * whose presence in that implementation file proves the gate exists.
 *
 * Deliberately minimal: a gate that is not listed here can never be
 * decided (its claim stays unverified), so an entry is added only when the
 * action's metadata/input list could be misread to imply its absence.
 */
export interface ActionGate {
  id: string;
  /**
   * The behavior subjects this gate implements, as lowercase words. The
   * scan matches subjects TOKEN-EXACTLY: a claim names a subject only when
   * the sentence carries the word itself. A shared RegExp would carry
   * state between sentences (`lastIndex` on a global pattern) and match
   * across word boundaries, so the vocabulary stays a plain word list.
   */
  subjects: readonly string[];
  /** Repo-relative path of the implementation inside the action's own source tree. */
  implementation: string;
  /** A literal byte sequence whose presence in that file proves the gate exists. */
  marker: string;
}

export const ACTION_GATES: readonly ActionGate[] = [
  {
    id: "draft-skip",
    subjects: ["draft", "drafts"],
    implementation: "src/precheck/decide.ts",
    // The #961 draft gate's `skip_reason` value, quoted: the unquoted
    // `pr-draft` also occurs inside the comment-command path's
    // `comment-pr-draft`, which is a different gate.
    marker: "\"pr-draft\"",
  },
  {
    id: "label-filter",
    subjects: ["label", "labels"],
    implementation: "src/precheck/decide.ts",
    // The #231 label-driven re-review skip: a labeled event whose label is
    // not the re-review label never reviews at all.
    marker: "\"unrelated-label\"",
  },
  {
    id: "closed-pr-skip",
    subjects: ["closed", "merged"],
    implementation: "src/precheck/decide.ts",
    // The #1301 closed/merged gate's `skip_reason` value, quoted: a
    // terminal PR (a merged PR reports `state: "closed"` on both forges) is
    // never reviewed on the shared admission path.
    marker: "\"pr-closed\"",
  },
];

/**
 * Gate behaviors the registry does NOT cover. The gate-absence scan can
 * name more behaviors than this registry speaks about (a dedupe or
 * fingerprint gate claim, for example); a claim naming one of them cannot
 * be decided by the action's own implementation, so the boundary marks it
 * unverified instead of guessing. Generic verbs ("skips", "gates",
 * "filters") name no behavior of their own and are deliberately absent.
 */
export const UNCOVERED_GATE_SUBJECTS: readonly string[] = [
  "dedupe",
  "dedupes",
  "fingerprint",
  "fingerprints",
];
