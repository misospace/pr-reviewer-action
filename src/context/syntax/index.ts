/** Syntax-aware related-code context (#764, phase 1) — the public surface.
 *
 * The stage is three pieces:
 *   - the provider seam (`./types.js`): a provider answers syntax questions
 *     about ONE file; the builder owns candidate discovery, budgets,
 *     provenance, filtering, truncation and fallback;
 *   - the builder (`./build.js`): never throws, always bounded, always
 *     provenance-carrying;
 *   - the renderers (`./render.js`): fence-safe Markdown and JSON.
 *
 * The default provider is dependency-free and structural; a parser-backed
 * provider can be registered through the registry (`./registry.js`) without
 * the builder changing. */

export {
  SUPPORTED_LANGUAGES,
  codeLinesFor,
  identifierPattern,
  identifiersIn,
  isKeyword,
  isSupportedLanguage,
  type SupportedLanguage,
} from "./grammar.js";
export {
  DEFAULT_SYNTAX_PROVIDER_ID,
  registerSyntaxProvider,
  resolveSyntaxProvider,
  syntaxProviderById,
  syntaxProviderIds,
  type SyntaxProviderResolution,
} from "./registry.js";
export {
  MAX_SYNTAX_BODY_CHARS,
  MAX_SYNTAX_BODY_LINES,
  MAX_SYNTAX_BYTES,
  MAX_SYNTAX_CANDIDATE_FILES,
  MAX_SYNTAX_CHANGED_FILE_CHARS,
  MAX_SYNTAX_CHANGED_LINES,
  MAX_SYNTAX_CHANGED_RANGES,
  MAX_SYNTAX_DECLARATIONS_PER_FILE,
  MAX_SYNTAX_ERRORS,
  MAX_SYNTAX_IDENTIFIERS_PER_LINE,
  MAX_SYNTAX_ITEMS,
  MAX_SYNTAX_NOTES,
  MAX_SYNTAX_PROVIDER_FAILURES,
  MAX_SYNTAX_REFERENCED_TOTAL,
  MAX_SYNTAX_SECONDS,
  MAX_SYNTAX_SNIPPET_CHARS,
  SYNTAX_CONTEXT_ARTIFACT_VERSION,
  buildSyntaxContext,
  syntaxContextToArtifact,
  type SyntaxContext,
  type SyntaxContextCaller,
  type SyntaxContextCallerDeclaration,
  type SyntaxContextDeclaration,
  type SyntaxContextDefinition,
  type SyntaxContextOptions,
  type SyntaxContextReference,
} from "./build.js";
export {
  MAX_SYNTAX_MARKDOWN_BYTES,
  SYNTAX_CLIP_MARKER,
  clipSyntaxContextMarkdown,
  renderSyntaxContextJson,
  renderSyntaxContextMarkdown,
} from "./render.js";
export { STRUCTURAL_PROVIDER_ID, structuralSyntaxProvider } from "./providers/structural.js";
export type {
  SyntaxDeclaration,
  SyntaxDeclarationKind,
  SyntaxFile,
  SyntaxProvider,
  SyntaxUsage,
} from "./types.js";
