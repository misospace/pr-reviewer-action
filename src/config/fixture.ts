/**
 * Fixture-mode repository-config CLI for tests-v3 and any future parity
 * harness boundary.
 *
 * `node dist/index.js repository-config-fixture <fixture.json>` applies the
 * #777 repository-config precedence rule over a fixture's operator inputs
 * and repository config file text (no git or filesystem I/O — the base-ref
 * read itself is exercised directly by `tests-v3/repository-config.test.ts`
 * against a real temporary git repository) and prints a single JSON line
 * `{ok, values}` where `values` is the `RepositoryConfigResolution`.
 */
import { readFileSync } from "node:fs";
import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { validateContract } from "./contract.js";
import { applyRepositoryConfig, type RepositoryConfigFile } from "./repository-config.js";

interface RepositoryConfigFixture {
  /** Operator (workflow) raw inputs, keyed by v3 kebab-case id. */
  operator_raw: Record<string, string>;
  /** Repository config file text, or `null`/omitted for "no file present". */
  repo_config_text?: string | null;
  /** Which candidate path the text came from (cosmetic; defaults to the
   * first candidate path). */
  repo_config_path?: string;
}

export function runRepositoryConfigFixture(fixturePath: string): {
  ok: boolean;
  values?: Record<string, unknown>;
  stderr?: string;
} {
  let fixture: RepositoryConfigFixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as RepositoryConfigFixture;
  } catch (error) {
    return { ok: false, stderr: `fixture unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const contract = validateContract(V3_CONTRACT);
    const file: RepositoryConfigFile | undefined = fixture.repo_config_text == null
      ? undefined
      : { path: fixture.repo_config_path ?? ".github/pr-reviewer.yml", text: fixture.repo_config_text };
    const resolution = applyRepositoryConfig(contract, fixture.operator_raw, file);
    return { ok: true, values: { ...resolution, raw: { ...resolution.raw } } };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}
