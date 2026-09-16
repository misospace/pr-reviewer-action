# Changelog

## [2.4.0](https://github.com/misospace/pr-reviewer-action/compare/v2.3.3...v2.4.0) (2026-09-16)


### Features

* **change-anchors:** extract deterministic change anchors from PR diffs ([#582](https://github.com/misospace/pr-reviewer-action/issues/582)) ([fc5f0d4](https://github.com/misospace/pr-reviewer-action/commit/fc5f0d483d1e7c6d21301e63278c22d2790ecb0a))
* **context:** add bounded PR thread context ([#606](https://github.com/misospace/pr-reviewer-action/issues/606)) ([e8cfa01](https://github.com/misospace/pr-reviewer-action/commit/e8cfa0103831821b3e9802926000cbc54f3c30aa))
* **context:** add related code scanner ([#600](https://github.com/misospace/pr-reviewer-action/issues/600)) ([4ce23b8](https://github.com/misospace/pr-reviewer-action/commit/4ce23b8ea71f5e6f9b2653c46f8998e429b0269f))
* **context:** add repository map context ([#599](https://github.com/misospace/pr-reviewer-action/issues/599)) ([219c6fb](https://github.com/misospace/pr-reviewer-action/commit/219c6fb20770fddeeb5241d80ff1e71fc64bd9dd))
* **context:** wire related code into reviews ([#601](https://github.com/misospace/pr-reviewer-action/issues/601)) ([f635ee5](https://github.com/misospace/pr-reviewer-action/commit/f635ee57996614bf79eb64b6cfbcbcede23d410f))
* **evidence:** normalize SARIF findings ([#602](https://github.com/misospace/pr-reviewer-action/issues/602)) ([51e31af](https://github.com/misospace/pr-reviewer-action/commit/51e31af7ad1693008917f17939d55c6ad96b0927))
* **evidence:** wire local SARIF files into the existing evidence pipeline ([#605](https://github.com/misospace/pr-reviewer-action/issues/605)) ([a0651d2](https://github.com/misospace/pr-reviewer-action/commit/a0651d27313ecbd3fa188f28afe0b5185ab0e8d4))
* **git_grep:** add path scoping and explicit result limits ([#596](https://github.com/misospace/pr-reviewer-action/issues/596)) ([baa075b](https://github.com/misospace/pr-reviewer-action/commit/baa075b7a8b3b50d2fb437a12eec239fdedb44c3))
* **publish:** add upstream_link_mode toggle for togithub.com links ([#562](https://github.com/misospace/pr-reviewer-action/issues/562)) ([5e6214a](https://github.com/misospace/pr-reviewer-action/commit/5e6214a5f1ff33d567c71a921bdd2237f903f781)), closes [#561](https://github.com/misospace/pr-reviewer-action/issues/561)
* **repo-map:** add deterministic bounded repository-map builder ([5764321](https://github.com/misospace/pr-reviewer-action/commit/57643211335849d2384c3482da20a38eb86fea4b))
* **tooling:** add bounded find_files tool for filename/path discovery ([#593](https://github.com/misospace/pr-reviewer-action/issues/593)) ([73692b1](https://github.com/misospace/pr-reviewer-action/commit/73692b17f65a237a4c0ff1e808f7d9947a9cdb33))
* **tools:** add bounded list_tree tool for repository discovery ([#566](https://github.com/misospace/pr-reviewer-action/issues/566)) ([9ce0066](https://github.com/misospace/pr-reviewer-action/commit/9ce006684d46e32a7e3a367e3939a2f2abeebca9))
* **tools:** add repo contents reader ([#604](https://github.com/misospace/pr-reviewer-action/issues/604)) ([5de3d65](https://github.com/misospace/pr-reviewer-action/commit/5de3d65647418b45ff231c8f4ac69c8a44c1a9cf))


### Bug Fixes

* **precheck:** fail closed when the [@ai-reviewer](https://github.com/ai-reviewer) dismiss permission check can't run ([#597](https://github.com/misospace/pr-reviewer-action/issues/597)) ([15007ab](https://github.com/misospace/pr-reviewer-action/commit/15007ab1304ee9741dfe50872f7a1b19180359a4))
* **repo-map:** address PR review on three artifact-contract issues ([f7cae56](https://github.com/misospace/pr-reviewer-action/commit/f7cae56af692ef66b22b2c37d99f725ed0daec49)), closes [#569](https://github.com/misospace/pr-reviewer-action/issues/569)


### Chores

* **dogfood:** raise native-loop budget to 4 rounds / 8 requests / 600s ([#594](https://github.com/misospace/pr-reviewer-action/issues/594)) ([56546a1](https://github.com/misospace/pr-reviewer-action/commit/56546a124079064f04940ac4f65f8372fa6871ec)), closes [#565](https://github.com/misospace/pr-reviewer-action/issues/565)

## [2.3.3](https://github.com/misospace/pr-reviewer-action/compare/v2.3.2...v2.3.3) (2026-09-08)


### Bug Fixes

* **action:** read fail_on_request_changes gate verdict from the output context ([#558](https://github.com/misospace/pr-reviewer-action/issues/558)) ([6cfa5bf](https://github.com/misospace/pr-reviewer-action/commit/6cfa5bfa29e68ed426bf943c9072e752eeefa313)), closes [#557](https://github.com/misospace/pr-reviewer-action/issues/557)
* **corpus:** gate the Tool Harness Findings section on harness output ([#560](https://github.com/misospace/pr-reviewer-action/issues/560)) ([243336a](https://github.com/misospace/pr-reviewer-action/commit/243336ad3dc2a9974320365ed15f300284fd6873))

## [2.3.2](https://github.com/misospace/pr-reviewer-action/compare/v2.3.1...v2.3.2) (2026-09-07)


### Bug Fixes

* **config:** let a single-provider configuration start ([#555](https://github.com/misospace/pr-reviewer-action/issues/555)) ([47385d4](https://github.com/misospace/pr-reviewer-action/commit/47385d40fd7488cf822018bcfc9ba380d652f2ce))

## [2.3.1](https://github.com/misospace/pr-reviewer-action/compare/v2.3.0...v2.3.1) (2026-09-05)


### Bug Fixes

* **carry-forward:** propagate needs_full_review so unverifiable carried findings trigger a full review next run ([#551](https://github.com/misospace/pr-reviewer-action/issues/551)) ([845427e](https://github.com/misospace/pr-reviewer-action/commit/845427e4bd4faffc8e64887f5676c537b3e0f678)), closes [#544](https://github.com/misospace/pr-reviewer-action/issues/544)
* **forgejo:** bound gh CLI subprocess calls with a timeout ([#548](https://github.com/misospace/pr-reviewer-action/issues/548)) ([d7f5670](https://github.com/misospace/pr-reviewer-action/commit/d7f5670f19d310f26ff9efae98d7f3fb8bb2fb57)), closes [#537](https://github.com/misospace/pr-reviewer-action/issues/537)
* **forgejo:** distinguish "unknown" permission from transport failure in preflight ([#545](https://github.com/misospace/pr-reviewer-action/issues/545)) ([dd27aaf](https://github.com/misospace/pr-reviewer-action/commit/dd27aaf8e71939721a8d32487a80b85ef38b0fbf)), closes [#539](https://github.com/misospace/pr-reviewer-action/issues/539)
* **forgejo:** make the Authorized Integration JWT cache thread-safe ([#547](https://github.com/misospace/pr-reviewer-action/issues/547)) ([57944ac](https://github.com/misospace/pr-reviewer-action/commit/57944ac4018ad7ff3f2cd1fd8da7481e673ee8cb)), closes [#538](https://github.com/misospace/pr-reviewer-action/issues/538)
* **precheck:** re-review on an unchanged diff when the blocker was CI state ([#550](https://github.com/misospace/pr-reviewer-action/issues/550)) ([267b862](https://github.com/misospace/pr-reviewer-action/commit/267b8628cc680c18c01390d5f0de1a2d3b2b3e1a))
* **precheck:** wire the [@ai-reviewer](https://github.com/ai-reviewer) dismiss directive into production ([#554](https://github.com/misospace/pr-reviewer-action/issues/554)) ([dd13151](https://github.com/misospace/pr-reviewer-action/commit/dd1315130eabe79480c42ae5355f444331e63e0e))


### Chores

* **tools:** rename dead tool_planning_* inputs to their actual purpose ([#552](https://github.com/misospace/pr-reviewer-action/issues/552)) ([75eefbc](https://github.com/misospace/pr-reviewer-action/commit/75eefbcb0bcfc396c86177ee31f4ca0369bfc046)), closes [#540](https://github.com/misospace/pr-reviewer-action/issues/540)


### Refactors

* **publish:** extract Publish step inline bash dispatcher to scripts/publish.sh ([#553](https://github.com/misospace/pr-reviewer-action/issues/553)) ([5b6b2cf](https://github.com/misospace/pr-reviewer-action/commit/5b6b2cf658ce634ba3e5b8eafe83ec2504600534)), closes [#541](https://github.com/misospace/pr-reviewer-action/issues/541)

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
