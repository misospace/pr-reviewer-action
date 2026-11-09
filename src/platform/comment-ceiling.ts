/** The single home of the forge comment-body ceiling (#1569).

 * GitHub and Forgejo both refuse a comment body over 65,536 bytes (the
 * character ceiling the forges document, applied here as the stricter
 * UTF-8 byte count). Everything that must respect that ceiling derives its
 * bound from this one constant instead of redeclaring `65_536` locally:
 * `FORGE_COMMENT_MAX_BYTES` in `src/controller/forge-capability.ts`,
 * `MAX_PUBLISHED_BODY_BYTES` in `src/publish/publish.ts`,
 * `REVIEW_BUNDLE_MAX_BYTES` in `src/publish/bundle.ts`, and
 * `MAX_COMMENT_BYTES` in `src/ingress/github-app-client.ts`.
 *
 * The equality between these bounds is a load-bearing invariant
 * (#1554/#1557/#1558): a payload that fits the payload ceiling but not the
 * comment ceiling gets the whole publication refused by the forge, so a
 * missed local redeclaration would silently reintroduce exactly the class
 * of oversized-body refusal those fixes closed. If a forge limit ever
 * changes, change it HERE and nowhere else.
 *
 * Out of scope by design: coincidental `65_536` caps with their own
 * semantics (`MAX_INSTRUCTION_FILE_BYTES`, `MAX_GIT_OUTPUT_BYTES`, and
 * similar) are unrelated limits and keep their own declarations.
 */
export const FORGE_COMMENT_MAX_BYTES = 65_536;
