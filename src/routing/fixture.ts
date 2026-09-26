import { readFileSync } from "node:fs";
import { isLowConfidence, reviewerRequestedEscalation, shouldEscalate } from "./escalation.js";

export function escalationFixtureMain(path: string): void {
  const f = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const output = f.output ?? {}; const flags = f.flags ?? {};
  const requested = reviewerRequestedEscalation(output);
  const telemetry = shouldEscalate(output, f.classification ?? {}, f.evidence ?? {}, f.harness ?? {}, { onIncomplete: flags.on_incomplete, onRequestChanges: flags.on_request_changes, onLowConfidence: flags.on_low_confidence, onBlockers: flags.on_blockers, onPlanningFailure: flags.on_planning_failure });
  process.stdout.write(`${JSON.stringify({ ok: true, values: { result: { ...requested, escalate: telemetry.escalate, reasons: telemetry.reasons, low_confidence: isLowConfidence(typeof output.review_markdown === "string" ? output.review_markdown : "") } } })}\n`);
}
