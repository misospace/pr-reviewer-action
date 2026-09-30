/** Model-failure notice and analysis-engine annotation (#706 PR 4):
 * byte-exact ports of `handle_model_failure` and `annotate_analysis_engine`
 * (`scripts/sections/review.sh`). */

import { pyDumpsAscii } from "../model/conversation.js";
import { bashLowerCapture } from "./bash.js";

export const MODEL_UNAVAILABLE_ENGINE = "(model unavailable)";

export type ModelFailureOutcome =
  /** Default `on-model-failure=fail`: the step fails (v2 `exit 1`). */
  | { readonly action: "fail"; readonly reason: string }
  /** `on-model-failure=notice`: publish a request_changes notice instead. */
  | {
    readonly action: "notice";
    readonly reason: string;
    readonly analysisEngine: string;
    /** Exact `ai-output.json` bytes v2 writes (Python `json.dumps`, ASCII,
     * trailing newline from `print`). */
    readonly aiOutputJson: string;
  };

/** The notice markdown `handle_model_failure` publishes. */
export function modelFailureNoticeMarkdown(reason: string): string {
  return (
    "## AI review could not run\n\n"
    + "The configured model endpoint(s) did not return a usable review for this run "
    + `(reason: ${reason}).\n\n`
    + "This is an automated notice, not a substantive review. Re-run the workflow "
    + "once the endpoint is reachable; see the action logs for the underlying error.\n"
  );
}

/** Port of `handle_model_failure`. `onModelFailure` is the raw input (v2
 * default `fail`); only a case-insensitive `notice` emits the notice. The
 * caller logs `reason` as the error line either way. */
export function handleModelFailure(reason: string, onModelFailure = ""): ModelFailureOutcome {
  if (bashLowerCapture(onModelFailure || "fail") !== "notice") return { action: "fail", reason };
  const aiOutputJson = `${pyDumpsAscii({ verdict: "request_changes", review_markdown: modelFailureNoticeMarkdown(reason) })}\n`;
  return { action: "notice", reason, analysisEngine: MODEL_UNAVAILABLE_ENGINE, aiOutputJson };
}

export type AnalysisEngineOrigin = "primary" | "fallback" | "escalated";

/** Routing state `annotate_analysis_engine` reads (`REVIEW_ROUTE`,
 * `ROUTE_REASON`, `ESCALATION_REASONS`); empty means unset. */
export interface EngineRouting {
  readonly reviewRoute?: string;
  readonly routeReason?: string;
  readonly escalationReasons?: string;
}

/** Port of `annotate_analysis_engine`: appends why this model produced the
 * review. A legacy (routing off) primary success stays unannotated. */
export function annotateAnalysisEngine(engine: string, origin: string, routing: EngineRouting = {}): string {
  switch (origin) {
    case "fallback":
      return `${engine} — fallback (primary failed)`;
    case "escalated":
      return `${engine} — escalated (${routing.escalationReasons || "unknown"})`;
    case "primary": {
      const route = routing.reviewRoute || "legacy";
      if (route === "primary") return `${engine} — primary route`;
      if (route === "smart") return `${engine} — routed smart (${routing.routeReason || "risk match"})`;
      return engine;
    }
    default:
      return engine;
  }
}

/** `"$AI_MODEL@$AI_BASE_URL ($AI_API_FORMAT)"` — the base engine string. */
export function analysisEngineBase(model: string, baseUrl: string, apiFormat: string): string {
  return `${model}@${baseUrl} (${apiFormat})`;
}

/** Strips the leading `@<baseUrl>` token `analysisEngineBase` adds (up to the
 * next whitespace, so a credentialed URL like `https://user:pass@host/v1`
 * disappears in full), keeping the model, API format, and any
 * `annotateAnalysisEngine` route suffix (#832): the endpoint URL is operator
 * configuration, not review content, so it must not leak into a published
 * review body. Callers that need the full string for logs or run artifacts
 * keep using the raw engine value. */
export function publicAnalysisEngine(engine: string): string {
  return engine.replace(/@\S+/, "");
}
