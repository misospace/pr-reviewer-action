import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { discoverRepositorySkills, readRepositorySkill, renderSkillCatalog } from "../src/context/repository-skills.js";

function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
test("catalog discovers only trusted-base regular skills and exact paths", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-skills-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
    mkdirSync(join(root, ".agents/skills/db-migration"), { recursive: true });
    writeFileSync(join(root, ".agents/skills/db-migration/SKILL.md"), "---\nname: Database migration\ndescription: Review schema changes\n---\nUse safe rollout.\n");
    git(root, "add", "."); git(root, "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD");
    const catalog = discoverRepositorySkills(base, root);
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0]?.name, "Database migration");
    assert.equal(readRepositorySkill(base, root, catalog.skills[0]!.path)?.includes("safe rollout"), true);
    assert.equal(readRepositorySkill(base, root, ".agents/skills/../../outside/SKILL.md"), null);
    assert.match(renderSkillCatalog(catalog.skills), /allowed path/);
    writeFileSync(join(root, ".agents/skills/db-migration/SKILL.md"), "PR-head attack");
    assert.equal(readRepositorySkill(base, root, catalog.skills[0]!.path)?.includes("PR-head attack"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
