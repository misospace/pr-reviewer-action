/** Byte-exact port of `truncate_clean` (scripts/sections/config.sh): truncate
 * SRC into DST at a UTF-8 / newline boundary (never mid-character or
 * mid-line), appending MARKER when truncation occurred. Replaces bare
 * `head -c`, which split multibyte characters and JSON/code fences.
 *
 * The v2 implementation is a Python heredoc over raw bytes; every branch here
 * mirrors it byte-for-byte (#676):
 *
 * 1. `len(data) <= max_b` → the input is copied verbatim (no marker).
 * 2. `len(suffix) > max_b` → a tiny `"." * min(max_b, 3)` sentinel (negative
 *    budgets repeat zero times, i.e. an empty file).
 * 3. Otherwise the clip is cut at `max_b - len(suffix)`, snapped back to the
 *    last newline (`rfind` result must be `> 0`, so a clip that *starts* with
 *    a newline keeps it), decoded UTF-8 with invalid bytes dropped
 *    (`errors="ignore"` — only reachable when the byte cut splits a multibyte
 *    character at the tail, or the source itself was not valid UTF-8), and
 *    re-encoded with `\n<MARKER>\n` appended.
 *
 * All inputs/outputs are raw bytes: callers pass and receive `Uint8Array`,
 * never strings, so hostile or truncated content cannot be silently
 * re-encoded differently from v2. */

const DOT = 0x2e;

/** Emulates Python's `bytes.decode("utf-8", errors="ignore")`: decodes every
 * maximal valid UTF-8 sequence and drops invalid/truncated bytes. Valid input
 * round-trips exactly; a byte-cut tail loses only the incomplete trailing
 * sequence. Surrogate code points (CESU) and overlong encodings are rejected
 * exactly like Python's strict UTF-8 decoder, which then drops them. */
export function decodeUtf8Ignore(data: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < data.length) {
    const b0: number = data[i] as number;
    let length = 0;
    let cp = 0;
    if (b0 < 0x80) {
      length = 1;
      cp = b0;
    } else if ((b0 & 0xe0) === 0xc0) {
      length = 2;
      cp = b0 & 0x1f;
    } else if ((b0 & 0xf0) === 0xe0) {
      length = 3;
      cp = b0 & 0x0f;
    } else if ((b0 & 0xf8) === 0xf0) {
      length = 4;
      cp = b0 & 0x07;
    } else {
      i += 1; // invalid start byte: dropped, resume at the next byte
      continue;
    }
    if (i + length > data.length) {
      i += 1; // truncated sequence: Python drops the bytes it cannot decode
      continue;
    }
    let ok = true;
    for (let k = 1; k < length; k += 1) {
      const cont: number = data[i + k] as number;
      if ((cont & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (cont & 0x3f);
    }
    const overlong =
      (length === 2 && cp < 0x80) || (length === 3 && cp < 0x800) || (length === 4 && cp < 0x10000);
    const surrogate = cp >= 0xd800 && cp <= 0xdfff;
    const beyond = cp > 0x10ffff;
    if (!ok || overlong || surrogate || beyond) {
      i += 1; // invalid sequence: drop the start byte and resume after it
      continue;
    }
    out += String.fromCodePoint(cp);
    i += length;
  }
  return out;
}

export function truncateClean(src: Uint8Array, maxBytes: number, marker: string): Uint8Array {
  if (src.length <= maxBytes) {
    return src;
  }
  const suffix = Buffer.from(`\n${marker}\n`, "utf8");
  if (suffix.length > maxBytes) {
    // A marker larger than the entire budget still needs a visible signal.
    const dots = Math.min(maxBytes, 3);
    return Buffer.alloc(dots > 0 ? dots : 0, DOT);
  }
  const clip = src.subarray(0, Math.max(0, maxBytes - suffix.length));
  let end = clip.length;
  const nl = clip.lastIndexOf(0x0a);
  if (nl > 0) {
    end = nl;
  }
  const text = decodeUtf8Ignore(clip.subarray(0, end));
  return Buffer.concat([Buffer.from(text, "utf8"), suffix]);
}
