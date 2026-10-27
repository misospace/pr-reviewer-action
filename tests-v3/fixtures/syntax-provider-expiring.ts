/** A syntax provider that signals the PARENT through the filesystem (#764).
 *
 * The provider used to flip a flag in the parent's memory. It now runs in
 * its own worker thread, so the flag cannot be shared: the provider writes
 * a MARKER FILE and the parent's injectable clock watches for it. The
 * provider itself is the structural one, so the build behaves exactly as
 * it did before the seam changed. */

import { writeFileSync } from "node:fs";
import { structuralSyntaxProvider } from "../../src/context/syntax/providers/structural.js";
import type { SyntaxDeclaration, SyntaxFile, SyntaxProvider, SyntaxUsage } from "../../src/context/syntax/types.js";

/** The options the registration hands to the factory. */
export interface ExpiringProviderOptions {
  /** The file the provider writes once it has answered an identifier
   * question: the parent's clock watches for it. */
  marker: string;
}

/** The factory the loader calls. */
export default function createExpiringProvider(options: Record<string, unknown> = {}): SyntaxProvider {
  const marker = typeof options.marker === "string" ? options.marker : "";
  const signal = (): void => {
    if (marker === "") return;
    try {
      writeFileSync(marker, "signalled");
    } catch {
      // The parent cannot see the marker: the build simply runs to its end.
    }
  };
  return {
    id: "expiring",
    declarations(file: SyntaxFile): readonly SyntaxDeclaration[] {
      return structuralSyntaxProvider.declarations(file);
    },
    identifiersOnLine(file: SyntaxFile, line: number): readonly string[] {
      signal();
      return structuralSyntaxProvider.identifiersOnLine(file, line);
    },
    classify(file: SyntaxFile, line: number, name: string): SyntaxUsage {
      return structuralSyntaxProvider.classify(file, line, name);
    },
  };
}
