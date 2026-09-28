/** Final-review user message (#706 PR 4): byte-exact port of
 * `build_user_message` (`scripts/sections/review.sh`), including its embedded
 * Python. The classification steering (pr_kind, risk flags with file
 * attribution, required checks) rides the short instruction channel because
 * weaker models weight it far above a mid-corpus section; every value comes
 * from the deterministic classifier, never from PR text.
 *
 * Python semantics reproduced: `json.load` failure or a non-dict document
 * falls back to the base message; `x or y` truthiness; `str()` of JSON
 * values; iterating a string/dict yields characters/keys; a shape Python
 * would raise on (a non-dict attribution map, a slice of a dict, a join over
 * non-strings, an unencodable lone surrogate) throws `UserMessageBuildError`
 * — under v2's `set -e` the failed capture aborts the review. The shell
 * capture then drops NULs and strips trailing newlines.
 *
 * Number literals keep their Python type through JSON.parse source-text
 * access: a literal with `.`/`e` is a float (`str(1e16)` is `1e+16`,
 * `str(3.0)` is `3.0`) and integers beyond 2^53 stay exact. Known limit:
 * Python-only `NaN`/`Infinity` literals fail JSON.parse and fall back to the
 * base message (the classifier never emits them). */

import { PyError, pyFloatRepr, pyReprString } from "../platform/py.js";
import { isPlainObject } from "../platform/jq.js";
import { bashCapture, type PromptWorkspace } from "./bash.js";
import { PROMPT_PRESENCE_FILES } from "./system-prompt.js";

export const USER_MESSAGE_BASE =
  "Analyze this pull request corpus and return STRICT JSON. Emit 'requirement_coverage' as null unless a Requirement Ledger section appears in the context; then one coverage entry per ledger requirement with status satisfied, violated, or unknown and concrete evidence entries (kind file, test, tool, ci, or diff, ref, detail). Mark a requirement unknown unless the supplied corpus proves it satisfied or violated.";

const REQUIRED_CHECKS_PREAMBLE =
  "Required checks — disposition EACH of these review questions in the "
  + "structured 'required_check_dispositions' array (echo each check text "
  + "exactly; status satisfied, not_applicable, or unresolved; a "
  + "not_applicable needs a concise rationale grounded in the actual "
  + "change). A check is a mandatory review question, not automatically "
  + "an implementation requirement: do not request changes merely because "
  + "a checklist names a test that is absent, and never invent additional "
  + "checks. Also address each one in review_markdown.";

export class UserMessageBuildError extends Error {
  constructor(message: string) {
    super(`user message build failed: ${message}`);
    this.name = "UserMessageBuildError";
  }
}

/** A JSON number literal Python parses as `float`. */
class PyFloat {
  constructor(readonly value: number) {}
}

type PyDict = Record<string, unknown>;

/** `json.loads` with Python number types preserved (floats boxed, big ints
 * as bigint). Throws on anything JSON.parse rejects. */
function pyJsonLoads(text: string): unknown {
  const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
  return parse(text, (_key, value, context) => {
    if (typeof value !== "number" || context?.source === undefined) return value;
    if (/[.eE]/.test(context.source)) return new PyFloat(value);
    return Number.isSafeInteger(value) ? value : BigInt(context.source);
  });
}

function isDict(value: unknown): value is PyDict {
  return isPlainObject(value) && !(value instanceof PyFloat);
}

function truthy(value: unknown): boolean {
  if (value instanceof PyFloat) return value.value !== 0;
  if (value === null || value === undefined || value === false || value === 0 || value === 0n || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** `d.get(key)` — None (null) when absent. */
function get(dict: PyDict, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
}

const or = (value: unknown, fallback: unknown): unknown => (truthy(value) ? value : fallback);

function repr(value: unknown): string {
  if (typeof value === "string") return pyReprString(value);
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (isDict(value)) return `{${Object.entries(value).map(([k, v]) => `${pyReprString(k)}: ${repr(v)}`).join(", ")}}`;
  return str(value);
}

/** `str(value)`. */
function str(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return repr(value);
}

/** `for x in value`. */
function iter(value: unknown, what: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PyError(`'${what}' is not iterable`);
}

/** `value[:n]`. */
function slice(value: unknown, n: number, what: string): unknown[] {
  if (Array.isArray(value)) return value.slice(0, n);
  if (typeof value === "string") return [...value].slice(0, n);
  throw new PyError(`'${what}' is not subscriptable`);
}

/** `", ".join(items)`. */
function join(items: unknown[], what: string): string {
  if (!items.every((item) => typeof item === "string")) throw new PyError(`'${what}' holds a non-str item`);
  return (items as string[]).join(", ");
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function steering(data: PyDict): string {
  const parts = [USER_MESSAGE_BASE];
  parts.push(`PR kind (deterministic classification): ${str(or(get(data, "pr_kind"), "unknown"))}.`);
  const flags = iter(or(get(data, "risk_flags"), []), "risk_flags").filter(truthy).map(str);
  const attribution = or(get(data, "risk_flags_with_files"), {});
  if (flags.length > 0) {
    const flagParts: string[] = [];
    for (const flag of flags.slice(0, 12)) {
      if (!isDict(attribution)) throw new PyError("'risk_flags_with_files' is not a dict");
      const filesForFlag = or(get(attribution, flag), []);
      if (truthy(filesForFlag)) {
        flagParts.push(`${flag} (triggered by: ${join(slice(filesForFlag, 5, flag), flag)})`);
      } else {
        flagParts.push(flag);
      }
    }
    parts.push(`Risk flags: ${flagParts.join(", ")}.`);
  }
  const checks = iter(or(get(data, "must_check"), []), "must_check").filter(truthy).map(str);
  if (checks.length > 0) {
    parts.push(REQUIRED_CHECKS_PREAMBLE);
    parts.push(...checks.slice(0, 12).map((check) => `- ${check}`));
  }
  return parts.join("\n");
}

/** Port of `build_user_message` over the workspace's classification file. */
export function buildUserMessage(workspace: PromptWorkspace, classificationFile: string = PROMPT_PRESENCE_FILES.classification): string {
  if (!workspace.isNonEmpty(classificationFile)) return USER_MESSAGE_BASE;
  const bytes = workspace.readBytes(classificationFile);
  const text = bytes === null ? null : decodeUtf8(bytes);
  let data: unknown;
  try {
    if (text === null) return USER_MESSAGE_BASE;
    data = pyJsonLoads(text);
  } catch {
    return USER_MESSAGE_BASE;
  }
  if (!isDict(data)) return USER_MESSAGE_BASE;
  let message: string;
  try {
    message = steering(data);
  } catch (error) {
    if (error instanceof PyError) throw new UserMessageBuildError(error.message);
    throw error;
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(message)) throw new UserMessageBuildError("output holds a lone surrogate (UnicodeEncodeError)");
  return bashCapture(message);
}
