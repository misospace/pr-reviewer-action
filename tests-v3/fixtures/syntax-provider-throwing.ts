/** A syntax provider that THROWS on every call (#764).
 *
 * The provider lives in its own worker thread: the fixture exports the
 * FACTORY the loader contract expects, and the factory returns a provider
 * that throws the way a broken provider would. The builder must degrade
 * the stage (an `errors` entry, empty items) and never throw. */

import { structuralSyntaxProvider } from "../../src/context/syntax/providers/structural.js";
import type { SyntaxDeclaration, SyntaxFile, SyntaxProvider, SyntaxUsage } from "../../src/context/syntax/types.js";

/** The factory the loader calls. */
export default function createThrowingProvider(): SyntaxProvider {
  return {
    id: "throwing",
    declarations(_file: SyntaxFile): readonly SyntaxDeclaration[] {
      throw new Error("provider exploded");
    },
    identifiersOnLine(_file: SyntaxFile, _line: number): readonly string[] {
      throw new Error("provider exploded");
    },
    classify(_file: SyntaxFile, _line: number, _name: string): SyntaxUsage {
      throw new Error("provider exploded");
    },
  };
}

/** The structural provider, re-exported so the fixture can be compared
 * with a working provider without importing it twice. */
export { structuralSyntaxProvider };
