import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, chown, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../src/acquisition/git-env.js";
import { mirrorDirName, MirrorCache } from "../src/acquisition/mirror.js";
import { createReviewWorkspace } from "../src/acquisition/workspace.js";
import { AcquisitionError } from "../src/acquisition/types.js";
import { initRepo, startGitHttpFixture, type GitHttpFixture } from "./acquisition-fixture.js";

const SECRET_AUTH = "Basic Zmlyc3R1c2VyOnNlY3JldC1jYW5hcnktZmlyc3R1c2Vy";
const REAL_GIT_PATH = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "acq-mirror-"));
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "gc.auto=0", ...args], {
    cwd: dir,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("mirrorDirName: stable digest keyed by coordinates, repo text never in the path", () => {
  const a = mirrorDirName("github", "org/repo");
  const b = mirrorDirName("github", "org/repo");
  const c = mirrorDirName("forgejo", "org/repo");
  const d = mirrorDirName("github", "org-other/repo");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{64}\.git$/);
  assert.throws(() => mirrorDirName("github", "../escape"));
  // #740: gitlab joined the declared vocabulary; an unknown label still fails.
  assert.notEqual(mirrorDirName("gitlab", "org/repo"), mirrorDirName("github", "org/repo"));
  assert.throws(() => mirrorDirName("bitbucket", "org/repo"));
});

// #1682: the acquisition seam accepts the DECLARED platform vocabulary, so
// its consumer accepts what the seam advertises. The declared id also keys the
// mirror directory: one controller can host a `forgejo` AND a `gitea`
// integration on the same cache root, and both may carry the same
// `owner/repo` name — a shared mirror would hand one product the other
// product's repository content.
test("mirrorDirName: the declared Gitea identity is a first-class platform with its own mirror", () => {
  const gitea = mirrorDirName("gitea", "org/repo");
  const forgejo = mirrorDirName("forgejo", "org/repo");
  assert.notEqual(gitea, forgejo, "a Gitea mirror is never the Forgejo family's mirror");
  assert.match(gitea, /^[0-9a-f]{64}\.git$/);
  assert.throws(() => mirrorDirName("bitbucket", "org/repo"), AcquisitionError);
});

test("a Gitea-declared mirror acquires the family's PR refs and records the family, not the product", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "gitea/repo");
    const prHead = await fixture.commit("gitea/repo", "pr.txt", "pr-only\n", "pr head commit", "refs/pull/7/head");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "gitea",
        repoFullName: "gitea/repo",
        cloneUrl: `${fixture.baseUrl}/gitea/repo.git`,
      });
      assert.equal(cache.platform, "gitea", "the mirror carries the declared identity");
      const info = await cache.ensureMirror();
      assert.equal(git(info.mirrorPath, ["cat-file", "-t", prHead]).trim(), "commit");
      const handle = await createReviewWorkspace(cache, { headSha: prHead });
      try {
        // The workspace info is a DURABLE record (it rides the execution
        // envelope), so it carries the wire family, never the product id.
        assert.equal(handle.info.platform, "forgejo");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a refused git spawn reports the launch reason, not exited unknown (#1722)", async () => {
  const root = await tempRoot();
  try {
    const cache = new MirrorCache({
      rootDir: root,
      platform: "github",
      repoFullName: "owner/repo",
      cloneUrl: "https://example.com/owner/repo.git",
      gitBinary: "/definitely-not-installed/pr-reviewer-git",
    });
    await assert.rejects(cache.ensureMirror(), (error: unknown) => {
      assert.ok(error instanceof AcquisitionError);
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, /git init --bare: spawn refused \(.+\)/);
      assert.doesNotMatch(error.message, /exited unknown/);
      // This diagnostic must never print argv, clone URL or other input.
      assert.doesNotMatch(error.message, /example\.com|owner\/repo|https:\/\//);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureMirror: a failing git run surfaces a bounded masked stderr class, never URL material (#1775)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "stderrclass/repo");
    const root = await tempRoot();
    try {
      const scratch = await mkdtemp(join(tmpdir(), "acq-sslgit-"));
      const sslGit = join(scratch, "git");
      // A git whose fetch dies the way a trust-store-less image dies
      // (exit 128 + "SSL CA cert"), with a credential-bearing canary URL
      // and a megabyte-sized padding run planted in the same stderr line:
      // the failure reason must carry the class, single-line, bounded,
      // with every URL/remote token replaced. Feeds the boundary token to
      // the boundary itself (#252).
      await writeFile(
        sslGit,
          "#!/bin/sh\n" +
          'for a in "$@"; do\n' +
          '  if [ "$a" = "fetch" ]; then\n' +
          "    printf 'remote: Counting objects: 100%% (1/1)\\rremote: noise\\r' >&2\n" +
          "    printf \"error: could not read from remote 'git@canary-scp.invalid:./secret/path/repo.git'\\n\" >&2\n" +
          "    printf \"fatal: unable to access 'https://canary-token@canary-host.invalid/leak/repo.git/': Problem with the SSL CA cert (path? access rights?) " +
            "A".repeat(1000) +
            "\\n\" >&2\n" +
          "    exit 128\n" +
          "  fi\n" +
          "done\n" +
          `exec ${REAL_GIT_PATH} "$@"\n`,
        { mode: 0o755 },
      );
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "stderrclass/repo",
        cloneUrl: `${fixture.baseUrl}/stderrclass/repo.git`,
        gitBinary: sslGit,
      });
      await assert.rejects(cache.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "fetch_failed");
        // The exit code AND the class that #1775 buried are both present.
        assert.match(error.message, /git fetch: exited 128/);
        assert.match(error.message, /SSL CA cert/);
        // Single line: no child newline/CR reaches the failure reason.
        assert.ok(!error.message.includes("\n"), "failure reason stays single-line");
        assert.ok(!error.message.includes("\r"), "failure reason stays single-line");
        // Never argv/URL material: not the scheme-URL canary, not the
        // scp-style `user@host:./path` remote, not even inside the fatal
        // line; and the LAST line survives (the noise lines above it do
        // not replace it).
        assert.doesNotMatch(error.message, /canary-token|canary-host\.invalid|canary-scp\.invalid|secret\/path|https:\/\//);
        assert.match(error.message, /<url>/);
        // Bounded: exit-code prefix + capped class + truncation marker.
        assert.match(error.message, /\.\.\.\[truncated\]$/);
        assert.ok(error.message.length <= 400, `failure reason must stay bounded: ${error.message.length}`);
        return true;
      });
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a failed git run with empty stderr keeps the bare exit-code message (#1775)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "quietfail/repo");
    const root = await tempRoot();
    try {
      const scratch = await mkdtemp(join(tmpdir(), "acq-quietgit-"));
      const quietGit = join(scratch, "git");
      await writeFile(
        quietGit,
        "#!/bin/sh\n" +
          'for a in "$@"; do\n' +
          '  if [ "$a" = "fetch" ]; then exit 128; fi\n' +
          "done\n" +
          `exec ${REAL_GIT_PATH} "$@"\n`,
        { mode: 0o755 },
      );
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "quietfail/repo",
        cloneUrl: `${fixture.baseUrl}/quietfail/repo.git`,
        gitBinary: quietGit,
      });
      await assert.rejects(cache.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "fetch_failed");
        assert.equal(error.message, "git fetch: exited 128");
        return true;
      });
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: an echoing child cannot return this run's credential in the failure reason (#1775)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "echocred/repo");
    const root = await tempRoot();
    try {
      const scratch = await mkdtemp(join(tmpdir(), "acq-echogit-"));
      const echoGit = join(scratch, "git");
      // The exact fetch credential (an opaque token with no recognizable
      // framing, so no heuristic pattern would catch it) printed back on
      // the TERMINAL stderr line, where last-line selection keeps it:
      // only the known-secret pass, fed the literal from the call site,
      // can then keep it out of the durable reason.
      const opaqueAuth = "opaque-canary-secret-9f3a7d21";
      await writeFile(
        echoGit,
        "#!/bin/sh\n" +
          'for a in "$@"; do\n' +
          '  if [ "$a" = "fetch" ]; then\n' +
          "    printf 'fatal: Authentication failed (auth=%s)\\n' \"$GIT_CONFIG_VALUE_0\" >&2\n" +
          "    exit 128\n" +
          "  fi\n" +
          "done\n" +
          `exec ${REAL_GIT_PATH} "$@"\n`,
        { mode: 0o755 },
      );
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "echocred/repo",
        cloneUrl: `${fixture.baseUrl}/echocred/repo.git`,
        credentials: { cloneUrl: `${fixture.baseUrl}/echocred/repo.git`, authorization: opaqueAuth },
        gitBinary: echoGit,
      });
      await assert.rejects(cache.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "fetch_failed");
        assert.match(error.message, /Authentication failed/);
        assert.match(error.message, /⟦•⟧/, "the credential was masked in place, not dropped with the line");
        assert.ok(!error.message.includes(opaqueAuth), "the literal credential must never surface");
        return true;
      });
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: invisible format characters cannot spoof the surfaced class (#1786 review)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "cfspoof/repo");
    const root = await tempRoot();
    try {
      const scratch = await mkdtemp(join(tmpdir(), "acq-cfgit-"));
      const cfGit = join(scratch, "git");
      // Attacker-influenced stderr built from the boundary characters
      // themselves (#252): a right-to-left override wrapping a spoofed
      // tail, isolates, zero-width joins inside an otherwise-plain word,
      // a scheme URL split across a zero-width space, and the same
      // evasion replayed with combining marks (grapheme joiner, variation
      // selector), which are Mn, not Cf — both split URLs must
      // reassemble and STRIP, not survive the URL pass unmatched.
      const spoofed =
        "fatal: review clean \u202Eno leak here\u202D\u2066done\u2069 re\u200Bpo\u200Drt failed " +
        "unable to access https:/\u200B/canary-zw-host.invalid/zw/repo.git/ " +
        "and ht\u034Ftp://canary-mn-host.invalid/mn/repo.git\uFE0F/ too";
      await writeFile(
        cfGit,
        "#!/bin/sh\n" +
          'for a in "$@"; do\n' +
          '  if [ "$a" = "fetch" ]; then\n' +
          `    printf '%s\\n' '${spoofed}' >&2\n` +
          "    exit 128\n" +
          "  fi\n" +
          "done\n" +
          `exec ${REAL_GIT_PATH} "$@"\n`,
        { mode: 0o755 },
      );
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "cfspoof/repo",
        cloneUrl: `${fixture.baseUrl}/cfspoof/repo.git`,
        gitBinary: cfGit,
      });
      await assert.rejects(cache.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.match(error.message, /git fetch: exited 128/);
        // No invisible Unicode survives into the operator-visible reason:
        // no bidi override/isolate, no zero-width mark, no combining mark.
        assert.ok(!/[\p{Cf}\p{Mn}]/u.test(error.message), "failure reason must be invisible-character-free");
        // Both invisible-split URLs reassembled and were stripped, not
        // surfaced as text the URL pass missed.
        assert.doesNotMatch(error.message, /canary-zw-host\.invalid|canary-mn-host\.invalid|zw\/repo|mn\/repo|https:\/\//);
        assert.match(error.message, /<url>/);
        // The spoofed-over content is inert plain text, single-line.
        assert.ok(!error.message.includes("\n") && !error.message.includes("\r"));
        return true;
      });
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a credential echoed with zero-width splices is still masked in place (#1786 review)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "cfcred/repo");
    const root = await tempRoot();
    try {
      const scratch = await mkdtemp(join(tmpdir(), "acq-cfcred-"));
      const cfCredGit = join(scratch, "git");
      const opaqueAuth = "opaque-canary-secret-4b8e1c55";
      // The credential echoed back with invisible characters spliced INTO
      // the literal — zero-width spaces, combining grapheme joiners, and
      // variation selectors (Cf and Mn) — so a plain exact-match pass
      // would walk past it. The NFC + invisible-character strip runs
      // first and reassembles the exact credential before the
      // known-secret pass sees it.
      const invisibles = ["\u200B", "\u034F", "\uFE0F"];
      const interleaved = Array.from(opaqueAuth)
        .map((char, index) => invisibles[index % invisibles.length] + char)
        .join("");
      await writeFile(
        cfCredGit,
        "#!/bin/sh\n" +
          'for a in "$@"; do\n' +
          '  if [ "$a" = "fetch" ]; then\n' +
          `    printf 'fatal: auth echoed %s\\n' '${interleaved}' >&2\n` +
          "    exit 128\n" +
          "  fi\n" +
          "done\n" +
          `exec ${REAL_GIT_PATH} "$@"\n`,
        { mode: 0o755 },
      );
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "cfcred/repo",
        cloneUrl: `${fixture.baseUrl}/cfcred/repo.git`,
        credentials: { cloneUrl: `${fixture.baseUrl}/cfcred/repo.git`, authorization: opaqueAuth },
        gitBinary: cfCredGit,
      });
      await assert.rejects(cache.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.match(error.message, /auth echoed/);
        assert.ok(!error.message.includes(opaqueAuth), "the reassembled credential must never surface");
        assert.ok(!/[\p{Cf}\p{Mn}]/u.test(error.message), "no invisible character survives");
        // Masked in place (the line survives), not smuggled through as
        // unreassembled fragments.
        assert.match(error.message, /⟦•⟧/);
        assert.ok(!error.message.includes("opaque\u200B"), "no fragment of the spliced credential survives");
        return true;
      });
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a capped head-only stderr capture is marked as truncated, never passed off as the class (#1786 review)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "capnoise/repo");
    const root = await tempRoot();
    try {
      const scratch = await mkdtemp(join(tmpdir(), "acq-capgit-"));
      const capGit = join(scratch, "git");
      // More padding than runProcess captures (1 MiB): the capture keeps
      // the HEAD, so git's terminal error line — printed after the
      // padding — is provably NOT in what the sanitizer can see. The
      // failure reason must say the capture was truncated instead of
      // presenting the padding head as git's real error class.
      await writeFile(
        capGit,
        "#!/bin/sh\n" +
          'for a in "$@"; do\n' +
          '  if [ "$a" = "fetch" ]; then\n' +
          "    head -c 1500000 /dev/zero | tr '\\0' 'A' >&2\n" +
          "    printf 'fatal: THE REAL TERMINAL ERROR LINE\\n' >&2\n" +
          "    exit 128\n" +
          "  fi\n" +
          "done\n" +
          `exec ${REAL_GIT_PATH} "$@"\n`,
        { mode: 0o755 },
      );
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "capnoise/repo",
        cloneUrl: `${fixture.baseUrl}/capnoise/repo.git`,
        gitBinary: capGit,
      });
      await assert.rejects(cache.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "fetch_failed");
        assert.match(error.message, /\[stderr truncated\]/, "the head-only capture is honestly marked");
        assert.ok(
          !error.message.includes("THE REAL TERMINAL ERROR LINE"),
          "the uncaptured tail is never claimed",
        );
        assert.match(error.message, /^git fetch: exited 128: \[stderr truncated\] /);
        assert.ok(!error.message.includes("\n") && !error.message.includes("\r"), "stays single-line");
        assert.ok(error.message.length <= 400, `failure reason must stay bounded: ${error.message.length}`);
        return true;
      });
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: init + full fetch, warm ensure is incremental (no rebuild, no reclone)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    const first = await initRepo(fixture, "warm/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "warm/repo",
        cloneUrl: `${fixture.baseUrl}/warm/repo.git`,
      });
      const cold = await cache.ensureMirror();
      assert.equal(cold.rebuilt, false);
      assert.equal(git(cold.mirrorPath, ["rev-parse", "refs/heads/main"]).trim(), first);
      // A commit that exists only via the canonical PR head ref (never on a
      // branch) is fetched too.
      const prHead = await fixture.commit("warm/repo", "pr.txt", "pr-only\n", "pr head commit", "refs/pull/7/head");
      const warm = await cache.ensureMirror();
      assert.equal(warm.rebuilt, false);
      assert.equal(warm.mirrorPath, cold.mirrorPath);
      assert.equal(git(warm.mirrorPath, ["rev-parse", "refs/pull/7/head"]).trim(), prHead);
      assert.equal(git(warm.mirrorPath, ["rev-parse", "refs/heads/main"]).trim(), first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: incremental fetch picks up an advanced base branch", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "advance/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "forgejo",
        repoFullName: "advance/repo",
        cloneUrl: `${fixture.baseUrl}/advance/repo.git`,
      });
      await cache.ensureMirror();
      const advanced = await fixture.commit("advance/repo", "base.txt", "advanced\n", "advance base");
      const info = await cache.ensureMirror();
      assert.equal(git(info.mirrorPath, ["rev-parse", "refs/heads/main"]).trim(), advanced);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: fork PR head ref lands in its own mirror without branch coordinates", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "base/repo");
    // The "fork": an independent repo whose commit is reachable from no branch
    // of the base repo; only the canonical pull ref exposes it.
    await initRepo(fixture, "contributor/fork");
    const forkOnly = await fixture.commit("contributor/fork", "fork.txt", "fork-only\n", "fork head", "refs/pull/12/head");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "forgejo",
        repoFullName: "contributor/fork",
        cloneUrl: `${fixture.baseUrl}/contributor/fork.git`,
      });
      const info = await cache.ensureMirror();
      assert.equal(git(info.mirrorPath, ["cat-file", "-t", forkOnly]).trim(), "commit");
      assert.notEqual(info.mirrorPath, mirrorDirName("forgejo", "base/repo"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: credentials travel only through the child env, never onto disk", async (t) => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "cred/repo");
    const root = await tempRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const cache = new MirrorCache({
      rootDir: root,
      platform: "github",
      repoFullName: "cred/repo",
      cloneUrl: `${fixture.baseUrl}/cred/repo.git`,
      credentials: { cloneUrl: `${fixture.baseUrl}/cred/repo.git`, authorization: SECRET_AUTH },
    });
    const info = await cache.ensureMirror();
    const configList = git(info.mirrorPath, ["config", "--list", "--local"]);
    assert.ok(!configList.includes(SECRET_AUTH));
    assert.ok(!configList.includes("extraheader"));
    assert.ok(!configList.includes("url."));
    // No persisted file anywhere in the cache root (mirror + worktree admin
    // + any workspace) carries the credential.
    const files = await listFiles(info.mirrorPath);
    const wsFiles = await listFiles(join(root, "workspaces")).catch(() => [] as string[]);
    for (const file of [...files, ...wsFiles]) {
      const content = await readFile(file).catch(() => Buffer.alloc(0));
      assert.ok(!content.includes(SECRET_AUTH), `credential leaked into ${file}`);
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a credential bound to a different host is refused at construction", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "mismatch/repo");
    const root = await tempRoot();
    try {
      assert.throws(
        () =>
          new MirrorCache({
            rootDir: root,
            platform: "github",
            repoFullName: "mismatch/repo",
            cloneUrl: `${fixture.baseUrl}/mismatch/repo.git`,
            credentials: { cloneUrl: "https://other.host/repo.git", authorization: SECRET_AUTH },
          }),
        (error: unknown) => error instanceof AcquisitionError && error.code === "invalid_config",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: the token reaches the child ENV only — never argv (recorder canary)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "canary/repo");
    const root = await tempRoot();
    try {
      const scratch = await mkdtemp(join(tmpdir(), "acq-recorder-"));
      const recordingDir = join(scratch, "rec");
      await mkdir(recordingDir, { recursive: true });
      // Recorder wrapper: logs argv + the credential env vars, then execs
      // the real git. Feeds the boundary token to the boundary itself.
      const fakeGit = join(scratch, "git");
      await writeFile(
        fakeGit,
        `#!/bin/sh\n` +
          `{\n` +
          `  echo "ARGS-BEGIN"\n` +
          `  for a in "$@"; do echo "$a"; done\n` +
          `  echo "ARGS-END"\n` +
          `  echo "ENV-COUNT=\${GIT_CONFIG_COUNT-}"\n` +
          `  echo "ENV-VALUE=\${GIT_CONFIG_VALUE_0-}"\n` +
          `} >> ${recordingDir}/log\n` +
          `exec ${REAL_GIT_PATH} "$@"\n`,
        { mode: 0o755 },
      );
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "canary/repo",
        cloneUrl: `${fixture.baseUrl}/canary/repo.git`,
        credentials: { cloneUrl: `${fixture.baseUrl}/canary/repo.git`, authorization: SECRET_AUTH },
        gitBinary: fakeGit,
      });
      await cache.ensureMirror();
      const log = await readFile(join(recordingDir, "log"), "utf8");
      assert.ok(log.includes(`ENV-VALUE=${SECRET_AUTH}`), "the token must ride the fetch child env");
      for (const block of log.split("ARGS-BEGIN").slice(1)) {
        const args = block.split("ARGS-END")[0] ?? "";
        assert.ok(!args.includes(SECRET_AUTH), "the token must never appear in argv");
      }
      assert.equal(log.split("ENV-COUNT=1").length - 1, 1, "exactly one invocation (the fetch) carries the credential");
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: mid-flight cancellation does not corrupt or delete the mirror", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "midabort/repo");
    const root = await tempRoot();
    try {
      const warm = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "midabort/repo",
        cloneUrl: `${fixture.baseUrl}/midabort/repo.git`,
      });
      const first = await warm.ensureMirror();
      // A hanging git: the abort lands mid-flight.
      const scratch = await mkdtemp(join(tmpdir(), "acq-hanggit-"));
      const hangGit = join(scratch, "git");
      await writeFile(hangGit, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
      const controller = new AbortController();
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "midabort/repo",
        cloneUrl: `${fixture.baseUrl}/midabort/repo.git`,
        fetchTimeoutMs: 30_000,
        gitBinary: hangGit,
        signal: controller.signal,
      });
      const pending = cache.ensureMirror();
      controller.abort();
      await assert.rejects(pending, AcquisitionError);
      // The healthy mirror survives: an aborted ensure must never rm it.
      await access(first.mirrorPath);
      const healthy = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "midabort/repo",
        cloneUrl: `${fixture.baseUrl}/midabort/repo.git`,
      });
      const after = await healthy.ensureMirror();
      assert.equal(after.rebuilt, false);
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a timed-out fetch on a healthy mirror leaves it intact (no rebuild)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "netfail/repo");
    const root = await tempRoot();
    try {
      const warm = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "netfail/repo",
        cloneUrl: `${fixture.baseUrl}/netfail/repo.git`,
      });
      const first = await warm.ensureMirror();
      // A fetch that hangs past a tiny timeout must fail as fetch_timeout
      // and leave the healthy mirror exactly as it was (no corruption
      // rebuild, no deletion).
      const scratch = await mkdtemp(join(tmpdir(), "acq-slowgit-"));
      const slowGit = join(scratch, "git");
      await writeFile(slowGit, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
      const timingOut = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "netfail/repo",
        cloneUrl: `${fixture.baseUrl}/netfail/repo.git`,
        gitBinary: slowGit,
        fetchTimeoutMs: 500,
      });
      await assert.rejects(timingOut.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "fetch_timeout");
        return true;
      });
      await access(first.mirrorPath);
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

test("ensureMirror: bounded fetch timeout is independent of any review deadline", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "slow/repo");
    const root = await tempRoot();
    try {
      const scratch = await mkdtemp(join(tmpdir(), "acq-fakegit-"));
      const fakeGit = join(scratch, "git");
      await writeFile(fakeGit, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "slow/repo",
        cloneUrl: `${fixture.baseUrl}/slow/repo.git`,
        fetchTimeoutMs: 500,
        gitBinary: fakeGit,
      });
      const started = Date.now();
      await assert.rejects(cache.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "fetch_timeout");
        return true;
      });
      assert.ok(Date.now() - started < 15_000, "timeout must not wait out the fake sleep");
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a pre-aborted signal refuses before launch", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "abort/repo");
    const root = await tempRoot();
    try {
      const controller = new AbortController();
      controller.abort();
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "abort/repo",
        cloneUrl: `${fixture.baseUrl}/abort/repo.git`,
        signal: controller.signal,
      });
      await assert.rejects(cache.ensureMirror(), AcquisitionError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: construction fails closed on invalid config", async () => {
  const fixture: GitHttpFixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "cfg/repo");
    const root = await tempRoot();
    try {
      assert.throws(
        () =>
          new MirrorCache({
            rootDir: root,
            platform: "github",
            repoFullName: "../escape",
            cloneUrl: `${fixture.baseUrl}/cfg/repo.git`,
          }),
        (error: unknown) => error instanceof AcquisitionError && error.code === "invalid_config",
      );
      assert.throws(
        () =>
          new MirrorCache({
            rootDir: root,
            platform: "github",
            repoFullName: "cfg/repo",
            cloneUrl: `file:///cfg/repo.git`,
          }),
        (error: unknown) => error instanceof AcquisitionError && error.code === "invalid_config",
      );
      assert.throws(
        () =>
          new MirrorCache({
            rootDir: root,
            platform: "github",
            repoFullName: "cfg/repo",
            cloneUrl: `https://token@host/cfg/repo.git`,
          }),
        (error: unknown) => error instanceof AcquisitionError && error.code === "invalid_config",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a corrupted mirror is detected and rebuilt exactly once", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "corrupt/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "corrupt/repo",
        cloneUrl: `${fixture.baseUrl}/corrupt/repo.git`,
      });
      const first = await cache.ensureMirror();
      // Corrupt the mirror's git config: every git command in the mirror
      // now fails (fetch AND the fsck probe), so the rebuild path must run.
      await writeFile(join(first.mirrorPath, "config"), " [core\n this is not config\n");
      const rebuilt = await cache.ensureMirror();
      assert.equal(rebuilt.rebuilt, true);
      assert.equal(rebuilt.mirrorPath, first.mirrorPath);
      const again = await cache.ensureMirror();
      assert.equal(again.rebuilt, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a planted symlink at the deterministic mirror path is refused, never initialized through", async () => {
  const root = await tempRoot();
  const outside = await mkdtemp(join(tmpdir(), "acq-escape-"));
  try {
    const victim = join(outside, "victim");
    await mkdir(victim, { recursive: true });
    const mirrorPath = join(root, mirrorDirName("github", "esc/repo"));
    await symlink(victim, mirrorPath);
    const cache = new MirrorCache({
      rootDir: root,
      platform: "github",
      repoFullName: "esc/repo",
      cloneUrl: "https://example.invalid/esc/repo.git",
    });
    await assert.rejects(cache.ensureMirror(), (error: unknown) => {
      assert.ok(error instanceof AcquisitionError);
      assert.equal(error.code, "invalid_config");
      return true;
    });
    // Nothing was written through the link: the target stays empty and the
    // link itself is untouched.
    assert.deepEqual(await readdir(victim), []);
    assert.ok((await lstat(mirrorPath)).isSymbolicLink());
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ensureMirror: a non-directory at the deterministic mirror path is refused", async () => {
  const root = await tempRoot();
  try {
    const mirrorPath = join(root, mirrorDirName("github", "file/repo"));
    await writeFile(mirrorPath, "not a mirror\n");
    const cache = new MirrorCache({
      rootDir: root,
      platform: "github",
      repoFullName: "file/repo",
      cloneUrl: "https://example.invalid/file/repo.git",
    });
    await assert.rejects(cache.ensureMirror(), (error: unknown) => {
      assert.ok(error instanceof AcquisitionError);
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, /not a directory/);
      return true;
    });
    // The planted file is untouched.
    assert.equal(await readFile(mirrorPath, "utf8"), "not a mirror\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureMirror: a corruption rebuild is deferred while a workspace is registered against the mirror", async () => {
  const fixture = await startGitHttpFixture();
  try {
    const head = await initRepo(fixture, "rebuild/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "rebuild/repo",
        cloneUrl: `${fixture.baseUrl}/rebuild/repo.git`,
      });
      const first = await cache.ensureMirror();
      const handle = await createReviewWorkspace(cache, { headSha: head });
      try {
        // Sanity: the worktree registration lives in the mirror's admin dir.
        assert.ok((await readdir(join(cache.path, "worktrees"))).length > 0);
        // Corrupt the mirror's git config: every git command in the mirror
        // fails (fetch AND the fsck probe), so the rebuild path is reached.
        await writeFile(join(first.mirrorPath, "config"), " [core\n this is not config\n");
        await assert.rejects(cache.ensureMirror(), (error: unknown) => {
          assert.ok(error instanceof AcquisitionError);
          assert.equal(error.code, "corrupt_mirror");
          assert.match(error.message, /rebuild deferred/);
          return true;
        });
        // The mirror and the active workspace are untouched: no rm ran.
        await access(first.mirrorPath);
        assert.ok((await readdir(handle.info.rootPath)).includes("README.md"));
        assert.ok((await readdir(join(cache.path, "worktrees"))).length > 0);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a corruption rebuild proceeds once no worktree registrations remain", async () => {
  const fixture = await startGitHttpFixture();
  try {
    const head = await initRepo(fixture, "rebuildfree/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "rebuildfree/repo",
        cloneUrl: `${fixture.baseUrl}/rebuildfree/repo.git`,
      });
      const first = await cache.ensureMirror();
      const handle = await createReviewWorkspace(cache, { headSha: head });
      // Close on the HEALTHY mirror so the registration is really removed;
      // the deferred rebuild must not be a permanent lockout.
      await handle.close();
      await writeFile(join(first.mirrorPath, "config"), " [core\n this is not config\n");
      const rebuilt = await cache.ensureMirror();
      assert.equal(rebuilt.rebuilt, true);
      assert.equal(rebuilt.mirrorPath, first.mirrorPath);
      const again = await cache.ensureMirror();
      assert.equal(again.rebuilt, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a stale registration whose workspace dir is gone is provably dead and does not defer", async () => {
  const fixture = await startGitHttpFixture();
  try {
    const head = await initRepo(fixture, "stale/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "stale/repo",
        cloneUrl: `${fixture.baseUrl}/stale/repo.git`,
      });
      const first = await cache.ensureMirror();
      const handle = await createReviewWorkspace(cache, { headSha: head });
      // Crashed-worker shape: the checkout is gone but the registration
      // survived (no close ran). The dangling gitdir is exactly what
      // `git worktree prune` would drop, so the rebuild must proceed.
      await rm(handle.info.rootPath, { recursive: true, force: true });
      await writeFile(join(first.mirrorPath, "config"), " [core\n this is not config\n");
      const rebuilt = await cache.ensureMirror();
      assert.equal(rebuilt.rebuilt, true);
      assert.equal(rebuilt.mirrorPath, first.mirrorPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: an uninspectable worktree listing defers the rebuild (fail closed)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "unprobe/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "unprobe/repo",
        cloneUrl: `${fixture.baseUrl}/unprobe/repo.git`,
      });
      const first = await cache.ensureMirror();
      // A planted file where the worktree admin dir belongs: the listing
      // cannot prove absence of registrations, so the rebuild defers.
      await writeFile(join(first.mirrorPath, "worktrees"), "not a directory\n");
      await writeFile(join(first.mirrorPath, "config"), " [core\n this is not config\n");
      await assert.rejects(cache.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "corrupt_mirror");
        assert.match(error.message, /rebuild deferred/);
        return true;
      });
      await access(first.mirrorPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a signalled fsck is not corruption evidence — the mirror is never deleted", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "signalled/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "signalled/repo",
        cloneUrl: `${fixture.baseUrl}/signalled/repo.git`,
      });
      const first = await cache.ensureMirror();
      const marker = " [core\n this is not config\n";
      await writeFile(join(first.mirrorPath, "config"), marker);
      // A git that fails every invocation, but kills itself (SIGKILL →
      // signalled status) when asked to fsck: the probe must NOT count
      // that as corruption evidence — the fetch error is rethrown and the
      // mirror (still carrying the corrupt config marker) is untouched.
      const scratch = await mkdtemp(join(tmpdir(), "acq-siggit-"));
      const sigGit = join(scratch, "git");
      await writeFile(
        sigGit,
        "#!/bin/sh\n" +
          `for a in "$@"; do\n` +
          `  if [ "$a" = "fsck" ]; then kill -9 $$; fi\n` +
          `done\n` +
          `exit 1\n`,
        { mode: 0o755 },
      );
      const cache2 = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "signalled/repo",
        cloneUrl: `${fixture.baseUrl}/signalled/repo.git`,
        gitBinary: sigGit,
      });
      await assert.rejects(cache2.ensureMirror(), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "fetch_failed");
        return true;
      });
      assert.equal(await readFile(join(first.mirrorPath, "config"), "utf8"), marker);
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a cache root writable by group or other is refused", async () => {
  const root = await tempRoot();
  try {
    await chmod(root, 0o770);
    const cache = new MirrorCache({
      rootDir: root,
      platform: "github",
      repoFullName: "perm/repo",
      cloneUrl: "https://example.invalid/perm/repo.git",
    });
    await assert.rejects(cache.ensureMirror(), (error: unknown) => {
      assert.ok(error instanceof AcquisitionError);
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, /writable by group or other/);
      return true;
    });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureMirror: a cache root owned by another uid is refused", {
  skip: process.getuid?.() !== 0 ? "requires root to plant a foreign-owned directory" : false,
}, async () => {
  const root = await tempRoot();
  try {
    await chown(root, 65534, 65534);
    const cache = new MirrorCache({
      rootDir: root,
      platform: "github",
      repoFullName: "owner/repo",
      cloneUrl: "https://example.invalid/owner/repo.git",
    });
    await assert.rejects(cache.ensureMirror(), (error: unknown) => {
      assert.ok(error instanceof AcquisitionError);
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, /not owned by the controller uid/);
      return true;
    });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureMirror: a cache root under a symlinked ancestor is refused, nothing initialized through the link", async () => {
  const base = await tempRoot();
  const outside = await mkdtemp(join(tmpdir(), "acq-ancestor-"));
  try {
    const link = join(base, "link");
    await symlink(outside, link);
    const cache = new MirrorCache({
      rootDir: join(link, "cache"),
      platform: "github",
      repoFullName: "anc/repo",
      cloneUrl: "https://example.invalid/anc/repo.git",
    });
    await assert.rejects(cache.ensureMirror(), (error: unknown) => {
      assert.ok(error instanceof AcquisitionError);
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, /not a real directory/);
      return true;
    });
    // The refusal happens BEFORE any git invocation: the link target is
    // untouched (at most an empty created directory, never a mirror, never
    // fetch writes).
    const created = await readdir(outside);
    for (const entry of created) {
      assert.deepEqual(await readdir(join(outside, entry)), []);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ensureMirror: a fresh nested cache root is created private and works", async () => {
  const fixture = await startGitHttpFixture();
  try {
    const head = await initRepo(fixture, "deepcrea/repo");
    const base = await tempRoot();
    const rootDir = join(base, "levels", "deep", "cache");
    try {
      const cache = new MirrorCache({
        rootDir,
        platform: "github",
        repoFullName: "deepcrea/repo",
        cloneUrl: `${fixture.baseUrl}/deepcrea/repo.git`,
      });
      const info = await cache.ensureMirror();
      assert.equal(git(info.mirrorPath, ["rev-parse", "refs/heads/main"]).trim(), head);
      for (const created of [join(base, "levels"), join(base, "levels", "deep"), rootDir]) {
        assert.equal((await lstat(created)).mode & 0o022, 0);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a registration with a symlinked gitdir file is unprovable and defers the rebuild", async () => {
  const fixture = await startGitHttpFixture();
  try {
    const head = await initRepo(fixture, "symgit/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "symgit/repo",
        cloneUrl: `${fixture.baseUrl}/symgit/repo.git`,
      });
      const first = await cache.ensureMirror();
      const handle = await createReviewWorkspace(cache, { headSha: head });
      try {
        const adminRoot = join(first.mirrorPath, "worktrees");
        const [registration] = await readdir(adminRoot);
        assert.ok(registration);
        const gitdirFile = join(adminRoot, registration, "gitdir");
        await rm(gitdirFile);
        // The link resolves to an EXISTING file whose content names a gone
        // workspace .git path: the old stat-then-readFile pair FOLLOWED the
        // link and wrongly proved the registration dead (the test fails on
        // the pre-fix code). The no-follow descriptor open refuses the link
        // itself (ELOOP), leaving the registration unproven.
        const decoy = join(root, "decoy-gitdir");
        await writeFile(decoy, "/nonexistent-acq-workspace/.git\n");
        await symlink(decoy, gitdirFile);
        await writeFile(join(first.mirrorPath, "config"), " [core\n this is not config\n");
        await assert.rejects(cache.ensureMirror(), (error: unknown) => {
          assert.ok(error instanceof AcquisitionError);
          assert.equal(error.code, "corrupt_mirror");
          assert.match(error.message, /rebuild deferred/);
          return true;
        });
        await access(first.mirrorPath);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("ensureMirror: a registration with an oversized gitdir file defers the rebuild", async () => {
  const fixture = await startGitHttpFixture();
  try {
    const head = await initRepo(fixture, "biggitdir/repo");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "biggitdir/repo",
        cloneUrl: `${fixture.baseUrl}/biggitdir/repo.git`,
      });
      const first = await cache.ensureMirror();
      const handle = await createReviewWorkspace(cache, { headSha: head });
      try {
        const adminRoot = join(first.mirrorPath, "worktrees");
        const [registration] = await readdir(adminRoot);
        assert.ok(registration);
        // Pins the fstat size bound of the new same-descriptor read path
        // (the pre-fix code deferred here too — regression coverage for the
        // rewrite, not a differentiator).
        await writeFile(join(adminRoot, registration, "gitdir"), "x".repeat(5000));
        await writeFile(join(first.mirrorPath, "config"), " [core\n this is not config\n");
        await assert.rejects(cache.ensureMirror(), (error: unknown) => {
          assert.ok(error instanceof AcquisitionError);
          assert.equal(error.code, "corrupt_mirror");
          assert.match(error.message, /rebuild deferred/);
          return true;
        });
        await access(first.mirrorPath);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});
