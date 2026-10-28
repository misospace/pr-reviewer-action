/** A syntax provider that BLOCKS FOREVER (#764).
 *
 * The point of the fixture: a provider that never returns must not be able
 * to hold the review past the stage's wall-clock bound. The provider
 * blocks SYNCHRONOUSLY (an infinite loop), so a bound that is only checked
 * before and after a provider call would never fire.
 *
 * The provider writes a HEARTBEAT while it blocks: the test reads it after
 * the build and proves the worker is gone (a worker that outlived the
 * build would keep writing). */

import { writeFileSync } from "node:fs";
import type { SyntaxDeclaration, SyntaxFile, SyntaxProvider, SyntaxUsage } from "../../src/context/syntax/types.js";

/** The options the registration hands to the factory. */
export interface BlockingProviderOptions {
  /** The file the provider writes while it blocks. */
  heartbeat: string;
}

/** Block the thread for `ms` milliseconds without spinning the CPU. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The factory the loader calls. */
export default function createBlockingProvider(options: Record<string, unknown> = {}): SyntaxProvider {
  const heartbeat = typeof options.heartbeat === "string" ? options.heartbeat : "";
  const beat = (): void => {
    if (heartbeat === "") return;
    try {
      writeFileSync(heartbeat, String(Date.now()));
    } catch {
      // The heartbeat is a test signal only: its absence changes nothing.
    }
  };
  return {
    id: "blocking",
    declarations(_file: SyntaxFile): readonly SyntaxDeclaration[] {
      for (;;) {
        beat();
        sleep(20);
      }
    },
    identifiersOnLine(_file: SyntaxFile, _line: number): readonly string[] {
      return [];
    },
    classify(_file: SyntaxFile, _line: number, _name: string): SyntaxUsage {
      return "unknown";
    },
  };
}
