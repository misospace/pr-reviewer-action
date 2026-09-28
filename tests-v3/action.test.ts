import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionStageEnv, eventLabelName, writeOutputs } from "../src/run/action.js";

function withDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "v3-action-"));
  return { dir, cleanup: (): void => rmSync(dir, { recursive: true, force: true }) };
}

test("action stage env: only endpoint + model given, everything else derived", () => {
  const { dir, cleanup } = withDir();
  try {
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ action: "opened", pull_request: { number: 42, head: { sha: "a".repeat(40) } } }));
    const stage = actionStageEnv({
      "INPUT_AI-BASE-URL": "https://llm.example.invalid/v1",
      "INPUT_AI-MODEL": "m",
      "INPUT_GITHUB-TOKEN": "tok",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_EVENT_PATH: event,
      GITHUB_SERVER_URL: "https://github.com",
    });
    assert.equal(stage.REPO, "o/r");
    assert.equal(stage.PR_NUMBER, "42");
    assert.equal(stage.GH_TOKEN, "tok");
    assert.equal(stage.FORGEJO_API_URL, "");
    // The agreed drop-in defaults reach the stages.
    assert.equal(stage.TOOL_MODE, "native_loop");
    assert.equal(stage.DEEP_REVIEW, "auto");
    assert.equal(stage.CI_STATUS_CHECK, "true");
    assert.equal(stage.PUBLISH_MODE, "review_comment");
    assert.equal(stage.ON_MODEL_FAILURE, "notice");
  } finally {
    cleanup();
  }
});

test("action stage env: a non-GitHub server URL is the Forgejo API base", () => {
  const stage = actionStageEnv({ "INPUT_AI-BASE-URL": "https://x.invalid", "INPUT_AI-MODEL": "m", GITHUB_SERVER_URL: "https://forge.example.invalid" });
  assert.equal(stage.FORGEJO_API_URL, "https://forge.example.invalid");
});

test("multiline outputs use a delimiter the value cannot forge", () => {
  const { dir, cleanup } = withDir();
  try {
    const out = join(dir, "out.txt");
    writeFileSync(out, "");
    writeOutputs({ GITHUB_OUTPUT: out }, [["review-markdown", "line1\nverdict=approve\nline3"], ["verdict", "request_changes"]]);
    const text = readFileSync(out, "utf8");
    const match = /^review-markdown<<(ghadelimiter_[0-9a-f]+)\n([\s\S]*?)\n\1\n/.exec(text);
    assert.ok(match, text);
    assert.equal(match[2], "line1\nverdict=approve\nline3");
    assert.match(text, /\nverdict=request_changes\n$/);
  } finally {
    cleanup();
  }
});

test("labeled events carry the label as an object with a name", () => {
  assert.equal(eventLabelName({ name: "ai-review" }), "ai-review");
  assert.equal(eventLabelName("ai-review"), "ai-review");
  assert.equal(eventLabelName(undefined), "");
});
