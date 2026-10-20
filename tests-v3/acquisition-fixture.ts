/** Test fixtures for the #732 acquisition module: real local git repos
 * served over a real smart-HTTP endpoint (`git http-backend` behind a
 * Node http server), so the module's http(s)-only clone-URL policy and its
 * actual fetch path are exercised without any network access.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitHttpFixture {
  /** Base URL: http://127.0.0.1:<port> */
  baseUrl: string;
  /** Root containing one directory per repo (non-bare, with a work tree). */
  projectRoot: string;
  /** Create/overwrite a commit in `<repo>`: writes `file` with `content` and commits.
   * `ref` is the branch the commit lands on (default main); parent resolved from it. */
  commit(repo: string, file: string, content: string, message: string, ref?: string): Promise<string>;
  /** Resolve a ref in `<repo>`. */
  revParse(repo: string, ref: string): Promise<string>;
  /** Update `<repo>`'s ref (e.g. refs/pull/7/head) to a SHA. */
  updateRef(repo: string, ref: string, sha: string): Promise<void>;
  close(): Promise<void>;
}

export function sh(dir: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
  return new Promise((resolveSh, rejectSh) => {
    const child = spawn("git", args, {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on("error", rejectSh);
    child.on("close", (code) => {
      if (code === 0) resolveSh(out);
      else rejectSh(new Error(`git ${args.join(" ")} failed (${code}): ${err}`));
    });
  });
}

/** Start a smart-HTTP git server fronting `git http-backend`. */
export async function startGitHttpFixture(): Promise<GitHttpFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "acq-repos-"));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        REQUEST_METHOD: req.method ?? "GET",
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
      },
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    req.pipe(child.stdin);
    child.on("close", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      const head = split === -1 ? raw.toString("utf8") : raw.subarray(0, split).toString("utf8");
      const body = split === -1 ? Buffer.alloc(0) : raw.subarray(split + 4);
      const lines = head.split("\r\n");
      const statusLine = lines.find((line) => line.toLowerCase().startsWith("status:"));
      const status = statusLine === undefined ? 200 : Number.parseInt(statusLine.slice(7).trim(), 10) || 200;
      const contentTypeLine = lines.find((line) => line.toLowerCase().startsWith("content-type:"));
      // git REQUIRES the smart-protocol content type on the advertisement.
      const contentType = contentTypeLine === undefined ? "application/octet-stream" : contentTypeLine.slice(13).trim();
      res.writeHead(Number.isFinite(status) ? status : 200, { "content-type": contentType });
      res.end(body);
    });
    child.on("error", () => {
      res.writeHead(500);
      res.end("http-backend failed to launch");
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Repos are served at <base>/<repo>.git, so on-disk dir names carry .git.
  const repoDir = (repo: string): string => join(projectRoot, `${repo}.git`);

  const fixture: GitHttpFixture = {
    baseUrl,
    projectRoot,
    async commit(repo, file, content, message, ref) {
      // Bare repo, plumbing-only commits: blob → tree → commit-tree →
      // update-ref. The env names are only for commit identity.
      const targetRef = ref ?? "refs/heads/main";
      const env = {
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      };
      const blob = (await sh(repoDir(repo), ["hash-object", "-w", "--stdin"], env, content)).trim();
      const tree = (await sh(repoDir(repo), ["mktree"], env, `100644 blob ${blob}\t${file}\n`)).trim();
      let parent = "";
      try {
        parent = (await sh(repoDir(repo), ["rev-parse", targetRef])).trim();
      } catch {
        parent = "";
      }
      const commitArgs = ["commit-tree", tree, "-m", message];
      if (parent !== "") commitArgs.push("-p", parent);
      const commitSha = (await sh(repoDir(repo), commitArgs, env)).trim();
      await sh(repoDir(repo), ["update-ref", targetRef, commitSha], env);
      return commitSha;
    },
    async revParse(repo, ref) {
      return (await sh(repoDir(repo), ["rev-parse", ref])).trim();
    },
    async updateRef(repo, ref, sha) {
      await sh(repoDir(repo), ["update-ref", ref, sha]);
    },
    async close() {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
  return fixture;
}

/** Initialize a BARE repo under the fixture root (served by git http-backend)
 * with an initial commit on main. */
export async function initRepo(fixture: GitHttpFixture, repo: string): Promise<string> {
  const dir = join(fixture.projectRoot, `${repo}.git`);
  await mkdir(dir, { recursive: true });
  await sh(dir, ["init", "--bare", "--initial-branch=main"]);
  return fixture.commit(repo, "README.md", "# fixture\n", "initial");
}
