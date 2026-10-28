/** A syntax provider that is SLOW BUT RETURNS (#764).
 *
 * The provider answers every question, but it takes longer than the bound
 * the build allows. A slow provider must be bounded exactly like a
 * blocking one: the stage gives up on it and degrades, instead of waiting
 * for an answer that arrives too late. */

import { structuralSyntaxProvider } from "../../src/context/syntax/providers/structural.js";
import type { SyntaxDeclaration, SyntaxFile, SyntaxProvider, SyntaxUsage } from "../../src/context/syntax/types.js";

/** The options the registration hands to the factory. */
export interface SlowProviderOptions {
  /** How long the provider takes, in milliseconds. */
  delayMs?: number;
}

/** Block the thread for `ms` milliseconds without spinning the CPU. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The factory the loader calls. */
export default function createSlowProvider(options: Record<string, unknown> = {}): SyntaxProvider {
  const delayMs = typeof options.delayMs === "number" && Number.isFinite(options.delayMs) ? options.delayMs : 2_000;
  return {
    id: "slow",
    declarations(file: SyntaxFile): readonly SyntaxDeclaration[] {
      sleep(delayMs);
      return structuralSyntaxProvider.declarations(file);
    },
    identifiersOnLine(file: SyntaxFile, line: number): readonly string[] {
      sleep(delayMs);
      return structuralSyntaxProvider.identifiersOnLine(file, line);
    },
    classify(file: SyntaxFile, line: number, name: string): SyntaxUsage {
      sleep(delayMs);
      return structuralSyntaxProvider.classify(file, line, name);
    },
  };
}
