/** Shared outbound user agent (#221 lineage). A non-default UA is required
 * because Cloudflare bot-fight fronting self-hosted Forgejo blocks the
 * default fetch/curl user agents. */
export const USER_AGENT = "ai-pr-reviewer/1.0";
