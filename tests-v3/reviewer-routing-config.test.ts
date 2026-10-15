import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_REVIEWER_ROUTING_FILE_BYTES,
  MAX_ROUTING_IDENTITIES_PER_TARGET,
  MAX_ROUTING_TARGETS,
  REVIEWER_ROUTING_CANDIDATE_PATHS,
  parseReviewerRouting,
  readReviewerRoutingFromRef,
  resolveReviewerRouting,
} from "../src/config/reviewer-routing.js";
import { RepositoryConfigError } from "../src/config/repository-config.js";

const PATH = REVIEWER_ROUTING_CANDIDATE_PATHS[0];

function parsed(text: string): { targets: Map<string, { users: readonly string[]; teams: readonly string[] }>; warnings: readonly string[] } {
  const result = parseReviewerRouting(text, PATH);
  assert.ok(!("malformed" in result), `unexpected malformed: ${JSON.stringify(result)}`);
  return result;
}

test("#1005: parses configured logical targets with users and teams", () => {
  const result = parsed([
    "targets:",
    "  platform:",
    "    users: [alice]",
    "    teams: [platform-team]",
    "  security:",
    "    teams: [security]",
    "",
  ].join("\n"));
  assert.deepEqual([...result.targets.keys()].sort(), ["platform", "security"]);
  assert.deepEqual(result.targets.get("platform"), { users: ["alice"], teams: ["platform-team"] });
  assert.deepEqual(result.targets.get("security"), { users: [], teams: ["security"] });
  assert.equal(result.warnings.length, 0);
});

test("#1005: lowercases target ids and team slugs, preserves user case, dedupes", () => {
  const result = parsed([
    "targets:",
    "  Platform:",
    "    users: [Alice, Alice]",
    "    teams: [Platform-Team, platform-team]",
    "",
  ].join("\n"));
  assert.deepEqual([...result.targets.keys()], ["platform"]);
  assert.deepEqual(result.targets.get("platform"), { users: ["Alice"], teams: ["platform-team"] });
});

test("#1005: drops an invalid target key, invalid identities, and an empty target with warnings", () => {
  const result = parsed([
    "targets:",
    "  Not A Slug:",
    "    users: [alice]",
    "  platform:",
    "    users: [alice, 'bad user', '@handle']",
    "    teams: ['Bad Team', 'ok-team']",
    "  empty:",
    "    users: []",
    "",
  ].join("\n"));
  assert.deepEqual([...result.targets.keys()], ["platform"]);
  assert.deepEqual(result.targets.get("platform"), { users: ["alice"], teams: ["ok-team"] });
  assert.ok(result.warnings.some((w) => /not a lowercase hyphenated slug/.test(w)));
  assert.ok(result.warnings.some((w) => /invalid user/.test(w)));
  assert.ok(result.warnings.some((w) => /invalid team/.test(w)));
  assert.ok(result.warnings.some((w) => /no valid users or teams/.test(w)));
});

test("#1005: malformed YAML, non-mapping, and non-mapping targets are rejected whole", () => {
  assert.ok("malformed" in parseReviewerRouting("targets: [", PATH));
  assert.ok("malformed" in parseReviewerRouting("- just\n- a\n- list\n", PATH));
  assert.ok("malformed" in parseReviewerRouting("targets: 7\n", PATH));
  // Absent targets is not malformed — it is simply no configured targets.
  const absent = parseReviewerRouting("other: 1\n", PATH);
  assert.ok(!("malformed" in absent));
  assert.equal((absent as { targets: Map<string, unknown> }).targets.size, 0);
});

test("#1005: an oversized file is malformed", () => {
  const big = `targets:\n  platform:\n    users: [${"a".repeat(MAX_REVIEWER_ROUTING_FILE_BYTES)}]\n`;
  const result = parseReviewerRouting(big, PATH);
  assert.ok("malformed" in result);
});

test("#1005: target and identity counts are capped", () => {
  const targets = Array.from({ length: MAX_ROUTING_TARGETS + 5 }, (_, i) => `  t${i}:\n    users: [u${i}]`).join("\n");
  const result = parsed(`targets:\n${targets}\n`);
  assert.equal(result.targets.size, MAX_ROUTING_TARGETS);

  const users = Array.from({ length: MAX_ROUTING_IDENTITIES_PER_TARGET + 5 }, (_, i) => `u${i}`).join(", ");
  const capped = parsed(`targets:\n  platform:\n    users: [${users}]\n`);
  assert.equal(capped.targets.get("platform")!.users.length, MAX_ROUTING_IDENTITIES_PER_TARGET);
});

// ---------------------------------------------------------------------------
// Base-ref read (trusted tree) — mirrors the repository-config tests.
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function commit(root: string, message: string): string {
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: GIT_ENV });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: GIT_ENV }).toString("utf8").trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "reviewer-routing-test-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env: GIT_ENV });
  return root;
}

function writeConfigFile(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

test("#1005: reads the routing config at the given base ref, ignoring the working tree", () => {
  const root = initRepo();
  writeFileSync(join(root, "README.md"), "seed\n");
  commit(root, "seed");
  writeConfigFile(root, PATH, "targets:\n  platform:\n    users: [alice]\n");
  const baseSha = commit(root, "base routing");

  // The PR head tries to point a target at a reviewer of its choosing.
  writeConfigFile(root, PATH, "targets:\n  platform:\n    users: [attacker]\n");
  commit(root, "head tries to rewrite routing");

  const file = readReviewerRoutingFromRef(baseSha, root);
  assert.ok(file);
  assert.equal(file.text, "targets:\n  platform:\n    users: [alice]\n");
  assert.equal(readFileSync(join(root, PATH), "utf8"), "targets:\n  platform:\n    users: [attacker]\n");
});

test("#1005: falls back to the second candidate path", () => {
  const root = initRepo();
  writeConfigFile(root, REVIEWER_ROUTING_CANDIDATE_PATHS[1], "targets:\n  security:\n    teams: [security]\n");
  const sha = commit(root, "root dotfile only");
  const file = readReviewerRoutingFromRef(sha, root);
  assert.ok(file);
  assert.equal(file.path, REVIEWER_ROUTING_CANDIDATE_PATHS[1]);
});

test("#1005: returns undefined when no candidate exists at a valid ref", () => {
  const root = initRepo();
  writeFileSync(join(root, "README.md"), "no routing here\n");
  const sha = commit(root, "no routing");
  assert.equal(readReviewerRoutingFromRef(sha, root), undefined);
});

test("#1005: a bad ref or non-git workspace throws (never silently no targets)", () => {
  assert.throws(() => readReviewerRoutingFromRef("", "/tmp"), RepositoryConfigError);
  const noGit = mkdtempSync(join(tmpdir(), "reviewer-routing-nogit-"));
  assert.throws(() => readReviewerRoutingFromRef("HEAD", noGit), RepositoryConfigError);
});

test("#1005: resolveReviewerRouting degrades to no targets with a warning on read failure", () => {
  const noGit = mkdtempSync(join(tmpdir(), "reviewer-routing-nogit2-"));
  const result = resolveReviewerRouting({ baseRef: "HEAD", workspace: noGit });
  assert.equal(result.targets.size, 0);
  assert.equal(result.sourcePath, null);
  assert.ok(result.warnings.some((w) => /could not be read from the base ref/.test(w)));
});
