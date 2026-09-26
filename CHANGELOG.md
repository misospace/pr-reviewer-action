# Changelog

## [3.0.0](https://github.com/misospace/pr-reviewer-action/compare/v2.5.0...v3.0.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* **review:** remove incremental-only escalation and review metadata state ([#618](https://github.com/misospace/pr-reviewer-action/issues/618)) (#645)
* **review:** remove carried findings and cross-run incremental evidence state ([#617](https://github.com/misospace/pr-reviewer-action/issues/617)) (#644)
* **review:** `review_scope`, `escalate_on_dirty_baseline`, `effective_review_scope`, `previous_head_sha`, and `baseline_clean` are removed; there is no replacement.

### Features

* **ci:** privilege-separated AI review for fork PRs ([#748](https://github.com/misospace/pr-reviewer-action/issues/748)) ([76d9baf](https://github.com/misospace/pr-reviewer-action/commit/76d9baf66fb266a8703893983b4efe11c072f410))
* **deep-review:** classifier-driven auto role selection ([#633](https://github.com/misospace/pr-reviewer-action/issues/633)) ([#655](https://github.com/misospace/pr-reviewer-action/issues/655)) ([3a1ea6f](https://github.com/misospace/pr-reviewer-action/commit/3a1ea6fdc9d7ff4a73b050393c635bb79ab37bdd))
* **deps:** update dependency @types/node (24.13.6 → 24.19.0) ([#760](https://github.com/misospace/pr-reviewer-action/issues/760)) ([77203aa](https://github.com/misospace/pr-reviewer-action/commit/77203aa9f27c64c990b02cf9e0ced5ed2c5b167a))
* **deps:** update dependency esbuild (0.25.5 → 0.28.2) ([#693](https://github.com/misospace/pr-reviewer-action/issues/693)) ([3f6bfbf](https://github.com/misospace/pr-reviewer-action/commit/3f6bfbfd8e75fadd46c82e08a0362241b1d1c196))
* **deps:** update dependency typescript (5.8.3 → 7.0.2) ([#696](https://github.com/misospace/pr-reviewer-action/issues/696)) ([1327d75](https://github.com/misospace/pr-reviewer-action/commit/1327d753cb46f8b91ec8da57294458c5a044248f))
* **evals:** A/B specialist execution shapes ([#635](https://github.com/misospace/pr-reviewer-action/issues/635)) ([#691](https://github.com/misospace/pr-reviewer-action/issues/691)) ([ae8bb25](https://github.com/misospace/pr-reviewer-action/commit/ae8bb258026d878e0e30a7d12bb4a206c62a27a9))
* **evals:** add historical semantic regression corpus ([#627](https://github.com/misospace/pr-reviewer-action/issues/627)) ([#646](https://github.com/misospace/pr-reviewer-action/issues/646)) ([f86bf2c](https://github.com/misospace/pr-reviewer-action/commit/f86bf2cfb06fb9346d30aae575200cc1a017310a))
* **evals:** add PR [#654](https://github.com/misospace/pr-reviewer-action/issues/654) execution-boundary fixtures ([#659](https://github.com/misospace/pr-reviewer-action/issues/659)) ([#664](https://github.com/misospace/pr-reviewer-action/issues/664)) ([894f092](https://github.com/misospace/pr-reviewer-action/commit/894f092f2d4c5df00af68abbb153e720c1015299))
* **publish:** resolve review threads of superseded managed reviews ([#769](https://github.com/misospace/pr-reviewer-action/issues/769)) ([6f5813a](https://github.com/misospace/pr-reviewer-action/commit/6f5813a42b0f418110abeaeb85f561218c8edcd6))
* **review:** add failure-path contract auditing to the correctness pass ([#648](https://github.com/misospace/pr-reviewer-action/issues/648)) ([ad79a2b](https://github.com/misospace/pr-reviewer-action/commit/ad79a2b101b225fa5a275574269051061dbe0376))
* **review:** budget and shape requests per tier ([#668](https://github.com/misospace/pr-reviewer-action/issues/668)) ([08a05b3](https://github.com/misospace/pr-reviewer-action/commit/08a05b3b440de81d302fe4b612731e06bb8d608b))
* **review:** gate unknown requirements ([#647](https://github.com/misospace/pr-reviewer-action/issues/647)) ([49190cb](https://github.com/misospace/pr-reviewer-action/commit/49190cb300518881935e8b2b1eb218f15ab71292))
* **review:** give smart escalation native tools ([#665](https://github.com/misospace/pr-reviewer-action/issues/665)) ([9334f02](https://github.com/misospace/pr-reviewer-action/commit/9334f02473d4cfa4745fff139be0a9707b3cd650))
* **review:** independent specialist corpus and output budget ([#632](https://github.com/misospace/pr-reviewer-action/issues/632)) ([#652](https://github.com/misospace/pr-reviewer-action/issues/652)) ([082cf92](https://github.com/misospace/pr-reviewer-action/commit/082cf920bed81c6f1467592d8545829cb8bbca70))
* **review:** make must_check a typed review obligation ([#750](https://github.com/misospace/pr-reviewer-action/issues/750)) ([#755](https://github.com/misospace/pr-reviewer-action/issues/755)) ([5900cfc](https://github.com/misospace/pr-reviewer-action/commit/5900cfc0b5f39f17e39901ae9b002672c11e3550))
* **review:** overlap specialist passes with CI gating ([#634](https://github.com/misospace/pr-reviewer-action/issues/634)) ([#654](https://github.com/misospace/pr-reviewer-action/issues/654)) ([38b79bb](https://github.com/misospace/pr-reviewer-action/commit/38b79bb3c927ddb608b1cc4b66f4cb733c1ae8ff))
* **review:** state outstanding human change requests in every review ([#774](https://github.com/misospace/pr-reviewer-action/issues/774)) ([73246dd](https://github.com/misospace/pr-reviewer-action/commit/73246ddffa1ca100ce69b836c4f54ca5f2f05d94))
* **review:** unresolved review threads as review context with dispositions ([#770](https://github.com/misospace/pr-reviewer-action/issues/770)) ([1591146](https://github.com/misospace/pr-reviewer-action/commit/15911464c1e32b23b093a6cb9974264f59a072ab))
* **routing:** make post-primary smart escalation reviewer-requested only ([#721](https://github.com/misospace/pr-reviewer-action/issues/721)) ([#743](https://github.com/misospace/pr-reviewer-action/issues/743)) ([9c13356](https://github.com/misospace/pr-reviewer-action/commit/9c133568e7bb6a62b6b8c19820bda367211c21cc))
* **tools:** per-tier request budget inputs ([#768](https://github.com/misospace/pr-reviewer-action/issues/768)) ([3da29c5](https://github.com/misospace/pr-reviewer-action/commit/3da29c551b8ac17ee300c8c77a2c67024d3978f0))
* **tools:** structured budget telemetry for the native loop ([#709](https://github.com/misospace/pr-reviewer-action/issues/709)) ([7c26e6d](https://github.com/misospace/pr-reviewer-action/commit/7c26e6da2b1908268e2fb544c0ac4731059fcccf))
* **tools:** tier-aware, exhaustion-aware native-loop request budgets ([#707](https://github.com/misospace/pr-reviewer-action/issues/707)) ([e2ca972](https://github.com/misospace/pr-reviewer-action/commit/e2ca972cc764fc8715518169acc5bf5bf4aa5be7))
* **transport:** bound v3 model response buffering ([#745](https://github.com/misospace/pr-reviewer-action/issues/745)) ([#754](https://github.com/misospace/pr-reviewer-action/issues/754)) ([55b5762](https://github.com/misospace/pr-reviewer-action/commit/55b5762d8fca63dc3274bc64a9cc9df6067dc12d))
* **v3:** define kebab-case action contract ([#687](https://github.com/misospace/pr-reviewer-action/issues/687)) ([95c4039](https://github.com/misospace/pr-reviewer-action/commit/95c4039501bb01333543c00e67f9799929d62013))
* **v3:** migrate classification, role selection, and requirement ledger to TypeScript ([#675](https://github.com/misospace/pr-reviewer-action/issues/675)) ([#708](https://github.com/misospace/pr-reviewer-action/issues/708)) ([39aa503](https://github.com/misospace/pr-reviewer-action/commit/39aa503cc736d45bfae9caeee22769d675ba558e))
* **v3:** migrate platform adapters and precheck path to TypeScript ([#674](https://github.com/misospace/pr-reviewer-action/issues/674)) ([#705](https://github.com/misospace/pr-reviewer-action/issues/705)) ([567977e](https://github.com/misospace/pr-reviewer-action/commit/567977e0452b63222c09a740bf6fc5694b8e6a49))
* **v3:** migrate remaining [#675](https://github.com/misospace/pr-reviewer-action/issues/675) context scope to TypeScript ([#716](https://github.com/misospace/pr-reviewer-action/issues/716)) ([ff47ef3](https://github.com/misospace/pr-reviewer-action/commit/ff47ef36c68a4dd71a263a959e729bca5aa5c873))
* **v3:** port corpus assembly to TypeScript ([#676](https://github.com/misospace/pr-reviewer-action/issues/676)) ([#746](https://github.com/misospace/pr-reviewer-action/issues/746)) ([37242e2](https://github.com/misospace/pr-reviewer-action/commit/37242e2721bee599e018da2d29969b9f9278268b))
* **v3:** port routing, escalation, conversation, and native tool loop ([#678](https://github.com/misospace/pr-reviewer-action/issues/678)) ([#761](https://github.com/misospace/pr-reviewer-action/issues/761)) ([7137b88](https://github.com/misospace/pr-reviewer-action/commit/7137b88e0e5874ba474d18936107ed52b70667ed))
* **v3:** port the model call layer to typescript ([#703](https://github.com/misospace/pr-reviewer-action/issues/703)) ([309aabf](https://github.com/misospace/pr-reviewer-action/commit/309aabfd6fec55b226908094fcc534116c5e6d83))
* **v3:** scaffold typed runtime ([#689](https://github.com/misospace/pr-reviewer-action/issues/689)) ([77736bf](https://github.com/misospace/pr-reviewer-action/commit/77736bfb50636d9ec27b9278800db7f685968567))
* **v3:** typed gates, evidence, and lifecycle ([#717](https://github.com/misospace/pr-reviewer-action/issues/717)) ([709bb6f](https://github.com/misospace/pr-reviewer-action/commit/709bb6f4217ae26c8fecb016b9e4f03d859cdc5b))
* **verdict:** coverage, docs and style findings cannot block on their own ([#772](https://github.com/misospace/pr-reviewer-action/issues/772)) ([66cef8a](https://github.com/misospace/pr-reviewer-action/commit/66cef8a0dd21406810a0b51a9e814ae811a4a452))
* **verdict:** decisive finding first ([#773](https://github.com/misospace/pr-reviewer-action/issues/773)) ([6ac94c5](https://github.com/misospace/pr-reviewer-action/commit/6ac94c560c1adfd36090b326bfe0967565d87ecc))


### Bug Fixes

* **ci:** wall-bound GitHub gh api polling attempts ([#688](https://github.com/misospace/pr-reviewer-action/issues/688)) ([d6889b4](https://github.com/misospace/pr-reviewer-action/commit/d6889b42652dfe405454075b1eba8830379d847d))
* **classifier:** require a real untrusted-path surface for path handling ([#756](https://github.com/misospace/pr-reviewer-action/issues/756)) ([a3abef6](https://github.com/misospace/pr-reviewer-action/commit/a3abef68e916532643d6c8e8342f7678ad379721))
* **classifier:** stop misclassifying module imports as path handling ([#720](https://github.com/misospace/pr-reviewer-action/issues/720)) ([9931ac6](https://github.com/misospace/pr-reviewer-action/commit/9931ac6276db3d654824b051494db91d00ab02ec))
* **dogfood:** exercise all specialist roles ([#667](https://github.com/misospace/pr-reviewer-action/issues/667)) ([702675e](https://github.com/misospace/pr-reviewer-action/commit/702675e074abfb7a0c08bcbdf1f8d4a7646bb8e5))
* **eval:** fixtures are same-repo PRs; configurable review timeout ([#771](https://github.com/misospace/pr-reviewer-action/issues/771)) ([645feb6](https://github.com/misospace/pr-reviewer-action/commit/645feb60365e8b0545cc0e0d7f12026e0eec0eb0))
* **evals:** fail eval-harness when every run errors ([#714](https://github.com/misospace/pr-reviewer-action/issues/714)) ([05aaafe](https://github.com/misospace/pr-reviewer-action/commit/05aaafee26f714451a4efd9889dab61ffd59adba))
* **evals:** retain diffs for specialists fixtures ([#713](https://github.com/misospace/pr-reviewer-action/issues/713)) ([fd4d8cd](https://github.com/misospace/pr-reviewer-action/commit/fd4d8cd402dbb2ee4929d9ee707171f388ee9423))
* **eval:** weekly summary reads per-mode rates from mode_summary ([#715](https://github.com/misospace/pr-reviewer-action/issues/715)) ([#744](https://github.com/misospace/pr-reviewer-action/issues/744)) ([4b17206](https://github.com/misospace/pr-reviewer-action/commit/4b17206388a96843cca204cee4d176a4da84f771))
* **image:** validate registry repository paths ([#724](https://github.com/misospace/pr-reviewer-action/issues/724)) ([864ffc1](https://github.com/misospace/pr-reviewer-action/commit/864ffc1a1bf8066b38a6cc328deda9422673f23c))
* **native-loop:** consume recoverable verdict retry, no duplicate synthesis ([#637](https://github.com/misospace/pr-reviewer-action/issues/637)) ([#651](https://github.com/misospace/pr-reviewer-action/issues/651)) ([345351c](https://github.com/misospace/pr-reviewer-action/commit/345351c2bf2074b5480d574aef500ebe69f82163))
* **platform:** valid PR-thread comment order ([#631](https://github.com/misospace/pr-reviewer-action/issues/631)) ([#649](https://github.com/misospace/pr-reviewer-action/issues/649)) ([d45a273](https://github.com/misospace/pr-reviewer-action/commit/d45a2737b6098bff3369a46d58c8c6911fd9eb6c))
* **precheck:** pin config reads to one fd ([#723](https://github.com/misospace/pr-reviewer-action/issues/723)) ([2ab2a3a](https://github.com/misospace/pr-reviewer-action/commit/2ab2a3a5b35ebe5a5e174fdf8399baef195979c8))
* **repo-map:** avoid auth filename backtracking ([#722](https://github.com/misospace/pr-reviewer-action/issues/722)) ([d70bc95](https://github.com/misospace/pr-reviewer-action/commit/d70bc952d863de3acd0a2c4216e32468717e4955))
* restore the reviewer's evidence gathering (v2 + v3) ([#759](https://github.com/misospace/pr-reviewer-action/issues/759)) ([339d998](https://github.com/misospace/pr-reviewer-action/commit/339d998b6e521776be51b02b08cb8800c574c4ad))
* **tool-loop:** honour an empty ai_temperature on native_loop planning turns ([#747](https://github.com/misospace/pr-reviewer-action/issues/747)) ([8f3c0a6](https://github.com/misospace/pr-reviewer-action/commit/8f3c0a68fe42c16bb63b92d230df46e3d1854f09))
* **verdict:** make non-blocking finding categories opt-in ([#775](https://github.com/misospace/pr-reviewer-action/issues/775)) ([1b83be8](https://github.com/misospace/pr-reviewer-action/commit/1b83be80c4c326f6c9ef00d2daaf97b670065afa))
* **verdict:** repair invalid escapes before accepting a partial candidate ([#767](https://github.com/misospace/pr-reviewer-action/issues/767)) ([d9b1a12](https://github.com/misospace/pr-reviewer-action/commit/d9b1a12cbded169dae07a2ebb50646a084879b1d))


### Documentation

* **agents:** slim AGENTS.md to durable rules, move detail to docs ([#751](https://github.com/misospace/pr-reviewer-action/issues/751)) ([#753](https://github.com/misospace/pr-reviewer-action/issues/753)) ([85ae3c3](https://github.com/misospace/pr-reviewer-action/commit/85ae3c375cae3ef62bdf77ba139c5f142d8168ab))
* **architecture:** keep three_call specialist shape on benchmark evidence ([#704](https://github.com/misospace/pr-reviewer-action/issues/704)) ([#710](https://github.com/misospace/pr-reviewer-action/issues/710)) ([4403d62](https://github.com/misospace/pr-reviewer-action/commit/4403d62708dd0578d73377a570ebcb6081e1efba))
* **runtime:** choose composite Node boundary ([#682](https://github.com/misospace/pr-reviewer-action/issues/682)) ([3a362a2](https://github.com/misospace/pr-reviewer-action/commit/3a362a2f19ed61a3db2affc1fa62e0620786604e))


### Refactors

* **action:** dedupe step env blocks into a shared $GITHUB_ENV export ([#653](https://github.com/misospace/pr-reviewer-action/issues/653)) ([00e7b01](https://github.com/misospace/pr-reviewer-action/commit/00e7b0172b38308dce3b1259d4151f195607de9c))
* **review:** collapse the review corpus to one full-PR path ([#643](https://github.com/misospace/pr-reviewer-action/issues/643)) ([ec9e038](https://github.com/misospace/pr-reviewer-action/commit/ec9e038763e804dca2d8539a868026a31861c852)), closes [#616](https://github.com/misospace/pr-reviewer-action/issues/616)
* **review:** remove carried findings and cross-run incremental evidence state ([#617](https://github.com/misospace/pr-reviewer-action/issues/617)) ([#644](https://github.com/misospace/pr-reviewer-action/issues/644)) ([07fb9d4](https://github.com/misospace/pr-reviewer-action/commit/07fb9d4629ff23ee2054e89a80bf87bc72c50bd1))
* **review:** remove incremental-only escalation and review metadata state ([#618](https://github.com/misospace/pr-reviewer-action/issues/618)) ([#645](https://github.com/misospace/pr-reviewer-action/issues/645)) ([a9dde07](https://github.com/misospace/pr-reviewer-action/commit/a9dde07c84b24e0072afad6a80792eaec0c74d74))
* **review:** remove the review-scope selection seam ([#615](https://github.com/misospace/pr-reviewer-action/issues/615)) ([#638](https://github.com/misospace/pr-reviewer-action/issues/638)) ([e2d74c2](https://github.com/misospace/pr-reviewer-action/commit/e2d74c2e9c42765d7a1552fb13d999cfc872ffd6))
* **review:** split render_linked_sources into single-purpose helpers ([#640](https://github.com/misospace/pr-reviewer-action/issues/640)) ([#650](https://github.com/misospace/pr-reviewer-action/issues/650)) ([2af34b8](https://github.com/misospace/pr-reviewer-action/commit/2af34b8f7793eeb7f7237246f4a171fb244830ca))

## [2.5.0](https://github.com/misospace/pr-reviewer-action/compare/v2.4.0...v2.5.0) (2026-09-20)


### Features

* **evals:** specialist-mode eval fixtures and effectiveness telemetry ([#610](https://github.com/misospace/pr-reviewer-action/issues/610)) ([#630](https://github.com/misospace/pr-reviewer-action/issues/630)) ([0b1ce16](https://github.com/misospace/pr-reviewer-action/commit/0b1ce16bad497f80b4ce141ff45ad7fce3d04b8a))
* **review:** add bounded specialist advisory-contract module ([#612](https://github.com/misospace/pr-reviewer-action/issues/612)) ([535f1b3](https://github.com/misospace/pr-reviewer-action/commit/535f1b384b4c245c6b51d57176ceac51510bbc88))
* **review:** add deep-review specialist advisory passes ([#608](https://github.com/misospace/pr-reviewer-action/issues/608)) ([#623](https://github.com/misospace/pr-reviewer-action/issues/623)) ([8b4f314](https://github.com/misospace/pr-reviewer-action/commit/8b4f314e829219e8a583983a21291d2763b02ee9))
* **review:** add requirement ledger with coverage credit ([#624](https://github.com/misospace/pr-reviewer-action/issues/624)) ([#628](https://github.com/misospace/pr-reviewer-action/issues/628)) ([f2e5c3b](https://github.com/misospace/pr-reviewer-action/commit/f2e5c3b9d1b07239692361c1a0daded2c538b6e8))
* **review:** feed specialist leads into final review synthesis ([#609](https://github.com/misospace/pr-reviewer-action/issues/609)) ([#629](https://github.com/misospace/pr-reviewer-action/issues/629)) ([cad7827](https://github.com/misospace/pr-reviewer-action/commit/cad78277c4f294f81f50570ade93258e0527f0fd))
* **tangled:** add ATProto CI session and record client ([#587](https://github.com/misospace/pr-reviewer-action/issues/587)) ([#611](https://github.com/misospace/pr-reviewer-action/issues/611)) ([d3b6fa2](https://github.com/misospace/pr-reviewer-action/commit/d3b6fa2221b277602fb677035391c315f797d48b))

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
