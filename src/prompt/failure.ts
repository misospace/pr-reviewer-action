/** Model-failure notice and analysis-engine annotation (#706 PR 4):
 * byte-exact ports of `handle_model_failure` and `annotate_analysis_engine`
 * (`scripts/sections/review.sh`). */

import { pyDumpsAscii } from "../model/conversation.js";
import { redactEndpointUrlCredential } from "../transport/http.js";
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

/** The tier each review route calls first, which is the tier that failed
 * when availability fallback runs. Unset and legacy call primary. A route
 * missing here names itself rather than reading as a primary failure. */
const FIRST_PASS_TIER: ReadonlyMap<string, string> = new Map([["", "primary"], ["legacy", "primary"], ["primary", "primary"]]);

/** The separator between the engine base and the route annotation
 * `annotateAnalysisEngine` appends. The published strip reads it to tell the
 * API-format group (which ends the engine base) from a parenthesis group
 * inside the endpoint token (#1474). */
const ANNOTATION_SEPARATOR = " — ";

/** Port of `annotate_analysis_engine`: appends why this model produced the
 * review. A legacy (routing off) primary success stays unannotated. */
export function annotateAnalysisEngine(engine: string, origin: string, routing: EngineRouting = {}): string {
  switch (origin) {
    case "fallback": {
      const route = routing.reviewRoute ?? "";
      return `${engine}${ANNOTATION_SEPARATOR}fallback (${FIRST_PASS_TIER.get(route) ?? route} failed)`;
    }
    case "escalated":
      return `${engine}${ANNOTATION_SEPARATOR}escalated (${routing.escalationReasons || "unknown"})`;
    case "primary": {
      const route = routing.reviewRoute || "legacy";
      // #965: there is no direct smart route anymore — the first pass is
      // primary or legacy; a smart second pass reports as "escalated".
      if (route === "primary") return `${engine}${ANNOTATION_SEPARATOR}primary route`;
      return engine;
    }
    default:
      return engine;
  }
}

/** `"$AI_MODEL@$AI_BASE_URL ($AI_API_FORMAT)"` — the base engine string.
 * #1428: a credential the endpoint URL carries in its userinfo is
 * structurally redacted, so the engine string (logs, run artifacts) never
 * echoes it; the published body strips the URL token entirely either way.
 * #1474: the base URL is trimmed here, exactly as the transport trims it
 * before the request — a lane base URL carrying edge whitespace would
 * otherwise compose an engine whose separator no longer opens the endpoint
 * token, and the whole URL would reach a published surface. */
export function analysisEngineBase(model: string, baseUrl: string, apiFormat: string): string {
  return `${model}@${redactEndpointUrlCredential(baseUrl.trim())} (${apiFormat})`;
}

/** Strips the `<baseUrl>` token `analysisEngineBase` adds after the model
 * separator `@`, keeping the model, API format, and any
 * `annotateAnalysisEngine` route suffix (#832): the endpoint URL is operator
 * configuration, not review content, so it must not leak into a published
 * review body. The separator is the `@` whose token opens `scheme://` (or
 * the #1428 fail-closed placeholder) — a model identifier may carry an `@`
 * of its own (#1469), so the strip cannot simply take the first or last
 * `@`. A composed endpoint token always: opens `scheme://` (or is the
 * placeholder), carries no userinfo (redaction removes it, and
 * `splitEndpointUserinfo` refuses any URL whose `@` falls outside the
 * authority, placeholdering the whole token instead), and ends right before
 * the API-format group. A candidate is accepted only when it meets all of
 * those; a model identifier's own URL-shaped token followed by the real
 * endpoint parses with userinfo (#1469 review), so it is skipped and the
 * scan resumes inside the rejected token, which consumed the candidates
 * nested in it. A model token that carries `/` or `#` before its own `@`
 * can still parse userinfo-free and be accepted, over-stripping the model —
 * the fail-safe direction: truncation, never endpoint text left behind.
 * When no candidate is acceptable the strip falls back to the first
 * candidate for the same reason. Callers that need the full string for
 * logs or run artifacts keep using the raw engine value.
 *
 * #1474: a base URL (or model identifier) that carries internal whitespace
 * splits the whitespace-free token run, so whitespace alone no longer
 * delimits the endpoint token — the token reaches the API-format group
 * instead, and the whole endpoint leaves with it. The group is the first
 * parenthesis group that ends the engine base, so a ` (` the endpoint (or
 * the model) carries of its own cannot be mistaken for it. The fail-closed
 * placeholder is a fixed sentinel token with no internal whitespace, so its
 * extent stays the whitespace-free run. */
const URL_TOKEN = /@(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|<redacted-endpoint-URL>)/;

/** The ` (` that opens a parenthesis group. */
const FORMAT_BOUNDARY = " (";

/** Whitespace ends a whitespace-free token run. */
const WHITESPACE = /\s/;

/** The end of the whitespace-free token run that starts at `start`: the
 * extent a composed endpoint token has when it carries no internal
 * whitespace. */
function tokenRunEnd(engine: string, start: number): number {
  let end = start;
  while (end < engine.length && !WHITESPACE.test(engine[end]!)) end += 1;
  return end;
}

/** The index of the `)` that closes the parenthesis group opened before
 * `from`, or -1 when the group never closes. */
function closingParen(engine: string, from: number): number {
  let depth = 1;
  for (let index = from; index < engine.length; index += 1) {
    const character = engine[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The index of the ` (` that opens the API-format group the endpoint token
 * ends at: the first parenthesis group whose closing paren ends the engine
 * base — the string ends there, or the route annotation follows. A base URL
 * or model identifier that carries a ` (` of its own therefore cannot be
 * mistaken for the format group (#1474). `-1` when the engine carries no
 * format group. */
function formatGroupStart(engine: string, from: number): number {
  for (let open = engine.indexOf(FORMAT_BOUNDARY, from); open >= 0; open = engine.indexOf(FORMAT_BOUNDARY, open + 1)) {
    const close = closingParen(engine, open + FORMAT_BOUNDARY.length);
    if (close < 0) continue;
    const after = engine.slice(close + 1);
    if (after === "" || after.startsWith(ANNOTATION_SEPARATOR)) return open;
  }
  return -1;
}

/** The end of the endpoint token: the API-format group opens it, so the
 * token ends right before that group — or at the end of the engine when it
 * carries none. */
function endpointTokenEnd(engine: string, start: number): number {
  const group = formatGroupStart(engine, start);
  return group < 0 ? engine.length : group;
}

function isEndpointToken(token: string, after: string): boolean {
  if (!after.startsWith(FORMAT_BOUNDARY) && after !== "") return false;
  const body = token.slice(1);
  if (body.startsWith("<redacted-endpoint-URL>")) return true;
  try {
    const url = new URL(body);
    return url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function publicAnalysisEngine(engine: string): string {
  const scanner = new RegExp(URL_TOKEN.source, "g");
  let first: { index: number; end: number } | null = null;
  for (let match = scanner.exec(engine); match !== null; match = scanner.exec(engine)) {
    const index = match.index;
    const runEnd = tokenRunEnd(engine, index);
    const groupEnd = endpointTokenEnd(engine, index);
    // The fail-closed placeholder is a fixed sentinel token: it carries no
    // internal whitespace, so its extent is the whitespace-free run. A
    // scheme-shaped URL can carry internal whitespace (#1474), so its extent
    // reaches the API-format group.
    const end = match[0].startsWith("@<redacted-endpoint-URL>") ? runEnd : groupEnd;
    // The fallback strips the widest extent: over-stripping the model is the
    // accepted fail-safe direction, endpoint text left behind is not.
    if (first === null) first = { index, end: groupEnd };
    if (isEndpointToken(engine.slice(index, end), engine.slice(end))) {
      return `${engine.slice(0, index)}${engine.slice(end)}`;
    }
    scanner.lastIndex = index + 1;
  }
  if (first === null) return engine;
  return `${engine.slice(0, first.index)}${engine.slice(first.end)}`;
}
