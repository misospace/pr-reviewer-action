# Changelog

## [2.3.0](https://github.com/misospace/pr-reviewer-action/compare/v2.2.1...v2.3.0) (2026-09-03)


### Features

* **carry_forward:** let a maintainer dismiss a carried finding ([#534](https://github.com/misospace/pr-reviewer-action/issues/534)) ([#535](https://github.com/misospace/pr-reviewer-action/issues/535)) ([623ec46](https://github.com/misospace/pr-reviewer-action/commit/623ec465546aaa3b6b868e74a27990f6afdd0a79))


### Bug Fixes

* **classifier:** stop matching bare route.&lt;ext&gt; in public_route_changes ([#532](https://github.com/misospace/pr-reviewer-action/issues/532)) ([e106089](https://github.com/misospace/pr-reviewer-action/commit/e10608958d74f3d9d18be0ae49a37a643047ab7e)), closes [#531](https://github.com/misospace/pr-reviewer-action/issues/531)
* **tools:** preserve standards evidence ([#542](https://github.com/misospace/pr-reviewer-action/issues/542)) ([d2412dc](https://github.com/misospace/pr-reviewer-action/commit/d2412dcb762a577547039e9db4bc9a3db4fed0fc))

## [2.2.1](https://github.com/misospace/pr-reviewer-action/compare/v2.2.0...v2.2.1) (2026-08-22)


### ⚠ BREAKING CHANGES

* **github-action:** Update action actions/setup-python (v5.6.0 → v7.0.0) ([#492](https://github.com/misospace/pr-reviewer-action/issues/492))
* **github-action:** Update action actions/upload-artifact (v4.6.2 → v7.0.1) ([#493](https://github.com/misospace/pr-reviewer-action/issues/493))
* **github-action:** Update action actions/checkout (v4.4.0 → v7.0.1) ([#491](https://github.com/misospace/pr-reviewer-action/issues/491))

### Features

* **action:** add fail_on_request_changes input to gate merges without a GitHub App ([#528](https://github.com/misospace/pr-reviewer-action/issues/528)) ([448b27b](https://github.com/misospace/pr-reviewer-action/commit/448b27bbef0fb612662aba7bbc5e7ff6d99950b1)), closes [#518](https://github.com/misospace/pr-reviewer-action/issues/518)


### Bug Fixes

* **classification:** pass impact pattern to awk via ENVIRON ([#481](https://github.com/misospace/pr-reviewer-action/issues/481)) ([787f619](https://github.com/misospace/pr-reviewer-action/commit/787f619da413617116b894f215e40b38feedeb6c))
* escalate on an empty completion instead of retrying the same model ([#525](https://github.com/misospace/pr-reviewer-action/issues/525)) ([3850b4a](https://github.com/misospace/pr-reviewer-action/commit/3850b4a86bb46e9f5df266cc0c5c14bf856ff443))
* **evidence:** scrub AI_PRIMARY_API_KEY, AI_SMART_API_KEY, LINEAR_API_KEY from provider env ([#522](https://github.com/misospace/pr-reviewer-action/issues/522)) ([322f88d](https://github.com/misospace/pr-reviewer-action/commit/322f88da78b03c7eeafa09a939e7495e3ed08976)), closes [#513](https://github.com/misospace/pr-reviewer-action/issues/513)
* give the native_loop verdict turn the real tool harness findings ([#527](https://github.com/misospace/pr-reviewer-action/issues/527)) ([edb0b02](https://github.com/misospace/pr-reviewer-action/commit/edb0b02bc4c5cc072f938ee3fe307978764bea3d))
* **precheck:** carry forward previous verdict on diff-unchanged skip ([#523](https://github.com/misospace/pr-reviewer-action/issues/523)) ([22b551e](https://github.com/misospace/pr-reviewer-action/commit/22b551ede8d66c443bbec18974f26fecf3d2f4df))
* resolve issue [#509](https://github.com/misospace/pr-reviewer-action/issues/509) ([#519](https://github.com/misospace/pr-reviewer-action/issues/519)) ([3d7459f](https://github.com/misospace/pr-reviewer-action/commit/3d7459f9ab4c4483e6b3ff14f0bb9b7ecb4454e7))
* route Forgejo auth header through 0600 curl --config file ([#486](https://github.com/misospace/pr-reviewer-action/issues/486)) ([e182061](https://github.com/misospace/pr-reviewer-action/commit/e182061739aad5bd32fe01361477103ed48e8e2a)), closes [#471](https://github.com/misospace/pr-reviewer-action/issues/471)
* **security:** restrict web_fetch URL scheme to http/https ([#479](https://github.com/misospace/pr-reviewer-action/issues/479)) ([7398d13](https://github.com/misospace/pr-reviewer-action/commit/7398d137f2efde9a964c408525060c480592316f)), closes [#468](https://github.com/misospace/pr-reviewer-action/issues/468)
* **ssrf:** gate host allowlist on resolved IP ([#520](https://github.com/misospace/pr-reviewer-action/issues/520)) ([b917fb2](https://github.com/misospace/pr-reviewer-action/commit/b917fb29aac8ecee9dc376194b2157c2913c77ad)), closes [#510](https://github.com/misospace/pr-reviewer-action/issues/510)
* update README from [@v1](https://github.com/v1) to [@v2](https://github.com/v2) and fix stale self-review section ([#487](https://github.com/misospace/pr-reviewer-action/issues/487)) ([b03949b](https://github.com/misospace/pr-reviewer-action/commit/b03949b530981cf1bb8d8f49d5f09636652f7b84)), closes [#470](https://github.com/misospace/pr-reviewer-action/issues/470)


### Chores

* **ci:** add gitleaks secret-scan step to validate job ([#521](https://github.com/misospace/pr-reviewer-action/issues/521)) ([fc3b02d](https://github.com/misospace/pr-reviewer-action/commit/fc3b02d6915c75944fff99d260533c0a757b8fe0))
* **ci:** add shellcheck to CI ([#467](https://github.com/misospace/pr-reviewer-action/issues/467)) ([61ec936](https://github.com/misospace/pr-reviewer-action/commit/61ec936b69a39af96b0be779bcb0af88e4446684))
* **ci:** pin test dependencies in requirements.txt for reproducible builds ([#526](https://github.com/misospace/pr-reviewer-action/issues/526)) ([91de1d7](https://github.com/misospace/pr-reviewer-action/commit/91de1d772d475dac21d3d56976821fbf0e044c00)), closes [#514](https://github.com/misospace/pr-reviewer-action/issues/514)
* release 2.2.1 ([#506](https://github.com/misospace/pr-reviewer-action/issues/506)) ([5669812](https://github.com/misospace/pr-reviewer-action/commit/566981250c0409662b2c6be638316e43085ae31e))


### Documentation

* clarify ai-pr-review-sha marker value in emit_review_markers ([#503](https://github.com/misospace/pr-reviewer-action/issues/503)) ([07b28c6](https://github.com/misospace/pr-reviewer-action/commit/07b28c6e56eb0d840036e526f2b3c00b14dd948e)), closes [#484](https://github.com/misospace/pr-reviewer-action/issues/484)
* issue contract for the autonomous loop ([#483](https://github.com/misospace/pr-reviewer-action/issues/483)) ([1243840](https://github.com/misospace/pr-reviewer-action/commit/12438401f09847793834fda84b888fa3a4c7a51b))


### Continuous Integration

* **github-action:** Update action actions/checkout (v4.4.0 → v7.0.1) ([#491](https://github.com/misospace/pr-reviewer-action/issues/491)) ([e002f7b](https://github.com/misospace/pr-reviewer-action/commit/e002f7b81aa960122c913768e7133bf5b0852487))
* **github-action:** Update action actions/setup-python (v5.6.0 → v7.0.0) ([#492](https://github.com/misospace/pr-reviewer-action/issues/492)) ([582e3c2](https://github.com/misospace/pr-reviewer-action/commit/582e3c2d41dc3a2d3138791290d72acb174e6b25))
* **github-action:** Update action actions/upload-artifact (v4.6.2 → v7.0.1) ([#493](https://github.com/misospace/pr-reviewer-action/issues/493)) ([caad320](https://github.com/misospace/pr-reviewer-action/commit/caad3205b2219eb0913b10fdddd710f9749cc167))
