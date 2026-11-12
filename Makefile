# Mirrors the CI secret-scan gate: same pinned gitleaks image (by digest,
# not tag), same args, scanning this checkout's available git history with
# the repo-root .gitleaks.toml, as in .github/workflows/ci.yaml.

.PHONY: secret-scan

secret-scan:
	docker run --rm \
		-v "$(CURDIR):/github/workspace" \
		ghcr.io/gitleaks/gitleaks@sha256:090a2715530bd6592342e6a66c3f35eafcaaf2a3227a312482504f9c854997e3 \
		git --config /github/workspace/.gitleaks.toml --no-banner --redact /github/workspace

# Runs the self-hosted qualification harness (#1486). The harness starts
# disposable containers, so it needs Docker. It reads the model settings and
# the forge credentials from the environment; see
# docs/self-hosted-qualification.md for the full list.
#
# The harness landed with #1482. The absent-harness branch below only
# covers checkouts that predate it: the target reports the absence and
# does nothing else rather than failing on a file that is simply not in
# the tree yet.
.PHONY: self-hosted-qualification

self-hosted-qualification:
	@if [ ! -f tests/self_hosted_e2e_qualification.sh ]; then \
		echo "SKIP: the self-hosted qualification harness (tests/self_hosted_e2e_qualification.sh) is not implemented yet (#1482)"; \
		exit 0; \
	fi; \
	if [ ! -f dist/index.js ]; then \
		echo "dist/index.js missing; building the v3 runtime bundle"; \
		npm ci --no-audit --no-fund && npm run build; \
	fi; \
	SELF_HOSTED_QUALIFICATION=true bash tests/self_hosted_e2e_qualification.sh
