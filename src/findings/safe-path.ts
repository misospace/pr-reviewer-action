/**
 * The one `safePath` predicate gating finding file paths (#1163).
 *
 * Three call sites consume finding file paths from untrusted model output
 * and must apply exactly this bar — `src/publish/inline-findings.ts` gates
 * comment anchors, `src/run/blocking-findings.ts` gates required-finding
 * file fields, and `src/outcomes/identity.ts` gates digest inputs. Before
 * #1163 the bar lived in three mirrored copies and the NUL rejection fixed
 * into the identity copy (#1115) was missed in the other two.
 *
 * Non-empty, repository-relative, no `..` segment, and no NUL: a finding's
 * file must be an anchor the forge can place, not an escape from the
 * repository. NUL is illegal in any POSIX path component, so a NUL-bearing
 * path is as unanchorable as an absolute or traversing one — and in the
 * blocking renderer it would survive the workflow-command escaping into a
 * raw NUL byte on a `::error` line. The predicate fails closed: an
 * unanchorable path proves no anchor, no location, and no stable identity.
 * Paths are only ever digested or rendered as strings — never opened — so
 * symlinks need no canonicalization and remain ordinary anchors.
 */
export function safePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.includes("\u0000")
    && !path.startsWith("/") && !path.split("/").includes("..");
}
