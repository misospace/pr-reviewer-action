/** Fixture shape: `{contract:"inline-findings/v1",cases:[{name,findings,diff,max,forgejo_positions,link_mode}]}`.
 * Each named value is the canonical sort_keys JSON of the comments array,
 * matching the v2 runner's `json.dumps(..., sort_keys=True, ensure_ascii=False)`. */
import { readFileSync } from "node:fs";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { buildComments } from "./inline-findings.js";

interface Case {
  name: string;
  findings?: unknown;
  diff?: string;
  max?: number;
  forgejo_positions?: boolean;
  link_mode?: string;
}

export function runInlineFindingsFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { contract?: string; cases?: Case[] };
    if (fixture.contract !== "inline-findings/v1" || !Array.isArray(fixture.cases)) throw new Error("fixture is not inline-findings/v1");
    const values: Record<string, string> = {};
    for (const item of fixture.cases) {
      const comments = buildComments(item.findings, item.diff ?? "", item.max ?? 20, {
        forgejoPositions: item.forgejo_positions === true,
        linkMode: item.link_mode ?? "inert",
      }).comments;
      values[item.name] = pythonJsonStringify(comments);
    }
    return { ok: true, values };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}
