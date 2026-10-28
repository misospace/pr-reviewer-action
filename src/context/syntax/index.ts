/** Syntax-aware related-code context (#764, phase 1) — the public surface.
 *
 * The stage is four pieces:
 *   - the provider seam (`./types.js`): a provider answers syntax questions
 *     about ONE file; the builder owns candidate discovery, budgets,
 *     provenance, filtering, truncation and fallback;
 *   - the builder (`./build.js`): never throws, always bounded, always
 *     provenance-carrying;
 *   - the provider boundary (`./provider-host.js` + `./provider-main.js`):
 *     every provider runs in an ISOLATED WORKER THREAD, and the parent
 *     terminates the worker when a call exceeds its bound, so a provider
 *     that blocks cannot outlive the build's wall-clock bound;
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
  BUILTIN_SYNTAX_PROVIDER_REGISTRATION,
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
  MAX_SYNTAX_PROVIDER_CALL_MS,
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
export {
  DEFAULT_PROVIDER_CALL_TIMEOUT_MS,
  SyntaxProviderTimeoutError,
  createProviderHost,
  type ProviderHostOptions,
  type SyntaxProviderHost,
} from "./provider-host.js";
export {
  MAX_SYNTAX_WORKER_CACHED_FILES,
  syntaxProviderWorker,
  type SyntaxProviderMethod,
  type SyntaxProviderRequest,
  type SyntaxProviderWorkerInit,
} from "./provider-main.js";
export { STRUCTURAL_PROVIDER_ID, structuralSyntaxProvider } from "./providers/structural.js";
export type {
  SyntaxDeclaration,
  SyntaxDeclarationKind,
  SyntaxFile,
  SyntaxProvider,
  SyntaxProviderLoader,
  SyntaxProviderRegistration,
  SyntaxUsage,
} from "./types.js";
