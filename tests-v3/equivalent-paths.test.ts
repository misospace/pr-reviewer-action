import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectEquivalentPathGroups,
  renderEquivalentPathsMarkdown,
  MAX_GROUPS,
  MAX_MEMBERS_PER_GROUP,
  type EquivalentPathsArtifact,
} from "../src/context/equivalent-paths.js";
import type { ChangeAnchorsArtifact, ChangeAnchorFile, ChangeAnchorSymbol } from "../src/context/change-anchors.js";

function withRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "equivalent-paths-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

function file(path: string, language: string, symbols: ChangeAnchorSymbol[]): ChangeAnchorFile {
  return { path, language, symbols, imports: [], identifiers: [] };
}

function anchors(files: ChangeAnchorFile[]): ChangeAnchorsArtifact {
  return { version: 1, files, anchors: [], truncated: false };
}

/** Minimal but faithful excerpt of the real `src/platform/tangled-bobbin.ts`
 * from misospace/pr-reviewer-action#854 (verified against the PR's actual
 * head revision, 84119b04c21378474f39c67fea8a9346cd4f24f9): the explicit-URI
 * branch of `resolveTangledPull` inlines its `return { ... }` right after
 * checking `targetRepo !== ctx.repoDid`; the list-based branch instead
 * calls the file-local `buildIdentity(...)` helper, whose own `return {
 * ... }` has the identical key set but performs no such check. Trimmed:
 * the pagination loop, `getJson`/`xrpc` helpers, and most error branches
 * (irrelevant to the two-path bug) are removed; every remaining line,
 * including exact identifiers, field order and comments, is copied
 * verbatim from the real file — this is not a re-modeled analogue. */
const TANGLED_BOBBIN_EXCERPT = [
  "export interface TangledPullIdentity {",
  "  uri: string;",
  "  cid: string;",
  "  rkey: string;",
  "  record: Record<string, unknown>;",
  "  repoDid: string;",
  "  authorDid: string;",
  "  targetBranch: string | undefined;",
  "  sourceBranch: string | undefined;",
  "  sourceRepoDid: string | undefined;",
  "  state: string | undefined;",
  "  sourceSha: string | undefined;",
  "}",
  "",
  "export async function resolveTangledPull(",
  "  ctx: TangledContext,",
  "  options?: ResolveTangledPullOptions,",
  "): Promise<TangledPullIdentity> {",
  "  const pullUri = options?.pullUri;",
  "  if (pullUri !== undefined && pullUri.trim() !== \"\") {",
  "    const trimmed = pullUri.trim();",
  "    const parsed = parseTangledAtUri(trimmed);",
  "    const { status, data } = await getJson(XRPC_GET_PULL, { pull: trimmed }, `pull not found: ${trimmed}`);",
  "    const record = asRecord(data);",
  "    const value = asRecord(record.value);",
  "    const finalCid = parsed.cid ?? str(record.cid) ?? \"\";",
  "    const target = asRecord(value.target);",
  "    const targetRepo = target === undefined ? undefined : str(target.repo);",
  "    if (ctx.repoDid !== undefined && targetRepo !== undefined && targetRepo !== ctx.repoDid) {",
  "      throw new TangledResolverError(",
  "        \"invalid-uri\",",
  "        `explicit pull targets repo ${targetRepo}, not context repo ${ctx.repoDid}`,",
  "      );",
  "    }",
  "    const source = asRecord(value.source);",
  "    return {",
  "      uri: `at://${parsed.did}/${parsed.collection}/${parsed.rkey}`,",
  "      cid: finalCid,",
  "      rkey: parsed.rkey,",
  "      record: value,",
  "      repoDid: targetRepo,",
  "      authorDid: parsed.did,",
  "      targetBranch: target === undefined ? undefined : str(target.branch),",
  "      sourceBranch: source === undefined ? undefined : str(source.branch),",
  "      sourceRepoDid: source === undefined ? undefined : str(source.repo),",
  "      state: str(record.state),",
  "      sourceSha: ctx.sourceSha,",
  "    };",
  "  }",
  "",
  "  const stateMatched = matched.filter((m) => m.state !== undefined && states.includes(m.state));",
  "  const buildIdentity = (m: PullMatch): TangledPullIdentity => {",
  "    const target = asRecord(m.value.target);",
  "    const repoDid = target === undefined ? undefined : str(target.repo);",
  "    const source = asRecord(m.value.source);",
  "    const cid = m.cid ?? \"\";",
  "    const p = parseTangledAtUri(m.uri);",
  "    return {",
  "      uri: m.uri,",
  "      cid,",
  "      rkey: p.rkey,",
  "      record: m.value,",
  "      repoDid,",
  "      authorDid: p.did,",
  "      targetBranch: target === undefined ? undefined : str(target.branch),",
  "      sourceBranch: source === undefined ? undefined : str(source.branch),",
  "      sourceRepoDid: source === undefined ? undefined : str(source.repo),",
  "      state: m.state,",
  "      sourceSha: ctx.sourceSha,",
  "    };",
  "  };",
  "",
  "  const first = stateMatched[0];",
  "  if (stateMatched.length === 1 && first !== undefined) {",
  "    return buildIdentity(first);",
  "  }",
  "  throw new TangledResolverError(\"no-match\", \"no match\");",
  "}",
  "",
].join("\n");

test("#854 (real shape): the explicit-check inline return and the list-based return-via-buildIdentity share a group", () => {
  const { root, cleanup } = withRoot();
  try {
    write(root, "src/platform/tangled-bobbin.ts", TANGLED_BOBBIN_EXCERPT);
    // `same_constructor` scans return sites directly from the file, not
    // from anchor symbols — deleted/path/language are all it needs here.
    const a = anchors([file("src/platform/tangled-bobbin.ts", "typescript", [])]);
    const result = detectEquivalentPathGroups(a, root);
    const group = result.groups.find((g) => g.rule === "same_constructor");
    assert.ok(group, "expected a same_constructor group");
    assert.equal(group!.members.length, 2);
    const lines = group!.members.map((m) => m.line).sort((x, y) => x - y);
    // Line 36 is the explicit branch's inline `return {`; line 75 is
    // `return buildIdentity(first);` in the list-based branch.
    assert.deepEqual(lines, [36, 75]);
    for (const m of group!.members) assert.equal(m.name.startsWith("resolveTangledPull"), true);
    const viaBuilder = group!.members.find((m) => m.line === 75)!;
    assert.match(viaBuilder.name, /\(via buildIdentity\)$/);
    const md = renderEquivalentPathsMarkdown(result);
    assert.match(md, /`src\/platform\/tangled-bobbin\.ts:36`/);
    assert.match(md, /`src\/platform\/tangled-bobbin\.ts:75`/);
  } finally {
    cleanup();
  }
});

test("return_type rule (generic, not #854): two same-file declarations sharing a declared return type form one group", () => {
  const { root, cleanup } = withRoot();
  try {
    write(
      root,
      "src/example.ts",
      [
        "export function resolveExplicit(uri: string, ctxRepoDid: string): Widget {",
        "  const targetRepo = fetchTarget(uri);",
        "  if (targetRepo !== ctxRepoDid) {",
        "    throw new Error('repo mismatch');",
        "  }",
        "  return { repoDid: targetRepo };",
        "}",
        "",
        "export function resolveFromList(ctxRepoDid: string): Widget {",
        "  const targetRepo = fetchFirst(ctxRepoDid);",
        "  return { repoDid: targetRepo };",
        "}",
        "",
      ].join("\n"),
    );
    const a = anchors([
      file("src/example.ts", "typescript", [
        { name: "resolveExplicit", kind: "function", confidence: "high", line: 1 },
        { name: "resolveFromList", kind: "function", confidence: "high", line: 9 },
      ]),
    ]);
    const result = detectEquivalentPathGroups(a, root);
    const group = result.groups.find((g) => g.rule === "return_type");
    assert.ok(group, "expected a return_type group");
    assert.equal(group!.shared, "Widget");
    assert.deepEqual(
      group!.members.map((m) => m.name).sort(),
      ["resolveExplicit", "resolveFromList"],
    );
    const md = renderEquivalentPathsMarkdown(result);
    assert.match(md, /^# Equivalent Paths to Compare/);
    assert.match(md, /`src\/example\.ts:1`\s+`resolveExplicit`/);
    assert.match(md, /`src\/example\.ts:9`\s+`resolveFromList`/);
  } finally {
    cleanup();
  }
});

test("same_constructor negative: a builder with only one path-level caller never forms a group", () => {
  const { root, cleanup } = withRoot();
  try {
    write(
      root,
      "src/single.ts",
      [
        "const buildThing = (x): Thing => {",
        "  return { a: x, b: x, c: x };",
        "};",
        "",
        "export function only() {",
        "  return buildThing(1);",
        "}",
        "",
      ].join("\n"),
    );
    const a = anchors([file("src/single.ts", "typescript", [])]);
    const result = detectEquivalentPathGroups(a, root);
    assert.equal(result.groups.some((g) => g.rule === "same_constructor"), false);
  } finally {
    cleanup();
  }
});

test("negative: unrelated functions with different return types are not grouped", () => {
  const { root, cleanup } = withRoot();
  try {
    write(
      root,
      "src/misc.ts",
      [
        "export function toWidgetCount(x: number): number {",
        "  return x + 1;",
        "}",
        "",
        "export function toWidgetName(x: number): string {",
        "  return String(x);",
        "}",
        "",
      ].join("\n"),
    );
    const a = anchors([
      file("src/misc.ts", "typescript", [
        { name: "toWidgetCount", kind: "function", confidence: "high", line: 1 },
        { name: "toWidgetName", kind: "function", confidence: "high", line: 5 },
      ]),
    ]);
    const result = detectEquivalentPathGroups(a, root);
    assert.equal(result.groups.length, 0);
    assert.equal(renderEquivalentPathsMarkdown(result), "");
  } finally {
    cleanup();
  }
});

test("negative: a lone function with a declared return type never forms a group", () => {
  const { root, cleanup } = withRoot();
  try {
    write(root, "src/one.ts", "export function solo(): Widget {\n  return widget;\n}\n");
    const a = anchors([file("src/one.ts", "typescript", [{ name: "solo", kind: "function", confidence: "high", line: 1 }])]);
    const result = detectEquivalentPathGroups(a, root);
    assert.equal(result.groups.length, 0);
  } finally {
    cleanup();
  }
});

test("caps: members per group are capped at MAX_MEMBERS_PER_GROUP and groups at MAX_GROUPS", () => {
  const { root, cleanup } = withRoot();
  try {
    // Six functions in one file sharing a return type: only MAX_MEMBERS_PER_GROUP survive.
    const lines: string[] = [];
    const symbols: ChangeAnchorSymbol[] = [];
    for (let i = 0; i < 6; i += 1) {
      symbols.push({ name: `variant${i}`, kind: "function", confidence: "high", line: lines.length + 1 });
      lines.push(`export function variant${i}(): SharedType {`, "  return shared();", "}", "");
    }
    write(root, "src/many.ts", lines.join("\n"));
    const a = anchors([file("src/many.ts", "typescript", symbols)]);
    const result = detectEquivalentPathGroups(a, root);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0]!.members.length, MAX_MEMBERS_PER_GROUP);

    // Four distinct return-type groups (each with 2 members) in one file:
    // only MAX_GROUPS survive (precision favors none arbitrarily dropped,
    // but the cap is hard).
    const groupedLines: string[] = [];
    const groupedSymbols: ChangeAnchorSymbol[] = [];
    for (let g = 0; g < 4; g += 1) {
      for (let m = 0; m < 2; m += 1) {
        groupedSymbols.push({ name: `g${g}m${m}`, kind: "function", confidence: "high", line: groupedLines.length + 1 });
        groupedLines.push(`export function g${g}m${m}(): Type${g} {`, "  return x();", "}", "");
      }
    }
    write(root, "src/grouped.ts", groupedLines.join("\n"));
    const b = anchors([file("src/grouped.ts", "typescript", groupedSymbols)]);
    const resultB = detectEquivalentPathGroups(b, root);
    assert.ok(resultB.groups.length <= MAX_GROUPS);
    assert.equal(resultB.groups.length, MAX_GROUPS);
  } finally {
    cleanup();
  }
});

test("adapter family: sibling *Adapter classes implementing the same method form a group", () => {
  const { root, cleanup } = withRoot();
  try {
    write(
      root,
      "src/storage/s3-adapter.ts",
      ["class S3Adapter {", "  write(key: string) {", "    return put(key);", "  }", "}", ""].join("\n"),
    );
    write(
      root,
      "src/storage/gcs-adapter.ts",
      ["class GcsAdapter {", "  write(key: string) {", "    return upload(key);", "  }", "}", ""].join("\n"),
    );
    const a = anchors([
      file("src/storage/s3-adapter.ts", "typescript", [{ name: "write", kind: "method", confidence: "high", line: 2 }]),
      file("src/storage/gcs-adapter.ts", "typescript", [{ name: "write", kind: "method", confidence: "high", line: 2 }]),
    ]);
    const result = detectEquivalentPathGroups(a, root);
    const adapterGroup = result.groups.find((g) => g.rule === "adapter_family");
    assert.ok(adapterGroup, "expected an adapter_family group");
    assert.equal(adapterGroup!.shared, "write");
    assert.equal(adapterGroup!.members.length, 2);
  } finally {
    cleanup();
  }
});

test("privileged operation: two same-file functions calling the same privileged call target form a group", () => {
  const { root, cleanup } = withRoot();
  try {
    write(
      root,
      "src/publish.ts",
      [
        "export function publishFromReview(payload) {",
        "  return publish(payload);",
        "}",
        "",
        "export function publishFromRetry(payload) {",
        "  return publish(payload);",
        "}",
        "",
      ].join("\n"),
    );
    const a = anchors([
      file("src/publish.ts", "javascript", [
        { name: "publishFromReview", kind: "function", confidence: "high", line: 1 },
        { name: "publishFromRetry", kind: "function", confidence: "high", line: 5 },
      ]),
    ]);
    const result = detectEquivalentPathGroups(a, root);
    const group = result.groups.find((g) => g.rule === "privileged_operation");
    assert.ok(group, "expected a privileged_operation group");
    assert.equal(group!.shared, "publish");
  } finally {
    cleanup();
  }
});

test("disabled/empty: no anchors, no source root, or an unreadable file yields no groups", () => {
  const empty: EquivalentPathsArtifact = detectEquivalentPathGroups(null, "/nonexistent");
  assert.equal(empty.groups.length, 0);
  const noRoot = detectEquivalentPathGroups(anchors([file("a.ts", "typescript", [])]), null);
  assert.equal(noRoot.groups.length, 0);
});

test("render: backticks and CR/LF in repo-derived values never break a code span (#252)", () => {
  const { root, cleanup } = withRoot();
  try {
    // A return_type group whose symbol names carry hostile backtick/CR
    // characters (anchor names are diff-derived and attacker-influenced).
    write(
      root,
      "src/evil.ts",
      [
        "export function one(): Shared {",
        "  return shared();",
        "}",
        "",
        "export function two(): Shared {",
        "  return shared();",
        "}",
        "",
      ].join("\n"),
    );
    const a = anchors([
      file("src/evil.ts", "typescript", [
        { name: "na`me", kind: "function", confidence: "high", line: 1 },
        { name: "na\rme", kind: "function", confidence: "high", line: 5 },
      ]),
    ]);
    const md = renderEquivalentPathsMarkdown(detectEquivalentPathGroups(a, root));
    const memberLines = md.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(memberLines.length, 2);
    // Each member line is exactly two well-formed code spans: a backtick in
    // a value cannot close the span early, and CR/LF cannot split the line.
    for (const line of memberLines) assert.match(line, /^- `[^`]*:\d+` `[^`]*`$/);
    assert.ok(memberLines.every((l) => l.endsWith("`name`")));

    // A same_constructor group whose object-literal key carries a backtick
    // (a quoted key passes the key-extraction regex verbatim). The #854
    // shape — a shared builder called from two sites — because a function
    // whose only top-level statement is `return { ... }` is itself a
    // builder, not a site.
    write(
      root,
      "src/keys.ts",
      [
        "const buildThing = (x) => {",
        "  return {",
        '    "ke`y": x,',
        "    b: x,",
        "    c: x,",
        "  };",
        "}",
        "",
        "export function first() {",
        "  return buildThing(1);",
        "}",
        "",
        "export function second() {",
        "  return buildThing(2);",
        "}",
        "",
      ].join("\n"),
    );
    const b = anchors([file("src/keys.ts", "typescript", [])]);
    const resultB = detectEquivalentPathGroups(b, root);
    const group = resultB.groups.find((g) => g.rule === "same_constructor");
    assert.ok(group, "expected a same_constructor group");
    const heading = renderEquivalentPathsMarkdown(resultB)
      .split("\n")
      .find((l) => l.startsWith("## Group 1:"))!;
    // The shared-key label is one well-formed span with the backtick stripped.
    assert.equal((heading.match(/`/g) ?? []).length, 2);
    assert.ok(heading.includes("`b, c, key`"));
  } finally {
    cleanup();
  }
});
