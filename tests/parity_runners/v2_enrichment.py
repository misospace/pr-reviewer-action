#!/usr/bin/env python3
"""Parity runner (v2 side, enrichment-normalization boundary, #675): runs the
pure normalization functions of pr_reviewer.enrichment against a fixture and
prints the canonical values for comparison with the v3 port. The DNS/fetch
security functions are NOT exercised — they are fetch policy that stays in
v2 until the fetch seam migrates."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.enrichment import (  # noqa: E402
    classify_url,
    extract_compare_shas,
    extract_ghcr_images,
    extract_urls,
    extract_version_hints,
    normalize_url,
    parse_allowed_hosts,
    select_target_version,
)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    body = fixture.get("body") or ""
    diff = fixture.get("diff") or ""
    url_limit = fixture.get("url_limit", 25)
    hint_limit = fixture.get("version_hint_limit", 180)

    urls = extract_urls(body, diff, url_limit)
    hints = extract_version_hints(diff, hint_limit)
    target_version = select_target_version(fixture.get("title"), hints)
    allowed_hosts = sorted(parse_allowed_hosts(fixture.get("allowed_hosts_raw") or ""))
    ghcr_images = extract_ghcr_images(hints, diff)
    compare_shas = extract_compare_shas(hints)
    url_classes = [classify_url(url) for url in (fixture.get("urls") or [])]

    print(json.dumps({
        "ok": True,
        "values": {
            "urls": json.dumps(urls, sort_keys=True, ensure_ascii=False),
            "normalized_urls": json.dumps([normalize_url(url) for url in urls], sort_keys=True, ensure_ascii=False),
            "allowed_hosts": json.dumps(allowed_hosts, sort_keys=True, ensure_ascii=False),
            "version_hints": json.dumps(hints, sort_keys=True, ensure_ascii=False),
            "target_version": json.dumps(target_version, sort_keys=True, ensure_ascii=False),
            "ghcr_images": json.dumps(ghcr_images, sort_keys=True, ensure_ascii=False),
            "compare_shas": json.dumps(compare_shas, sort_keys=True, ensure_ascii=False),
            "url_classes": json.dumps(url_classes, sort_keys=True, ensure_ascii=False),
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
