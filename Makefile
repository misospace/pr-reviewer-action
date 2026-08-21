# Mirrors the CI secret-scan gate: same pinned gitleaks image (by digest,
# not tag), same args, scanning this checkout's available git history with
# the repo-root .gitleaks.toml, as in .github/workflows/ci.yaml.

.PHONY: secret-scan

secret-scan:
	docker run --rm \
		-v "$(CURDIR):/github/workspace" \
		ghcr.io/gitleaks/gitleaks@sha256:090a2715530bd6592342e6a66c3f35eafcaaf2a3227a312482504f9c854997e3 \
		git --config /github/workspace/.gitleaks.toml --no-banner --redact /github/workspace
