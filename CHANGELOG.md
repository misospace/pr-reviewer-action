# Changelog

## [3.1.0](https://github.com/misospace/pr-reviewer-action/compare/source-v3.0.1...source-v3.1.0) (2026-10-01)


### Features

* **tools:** raise the native-loop budget and report a real cache hit ratio ([#911](https://github.com/misospace/pr-reviewer-action/issues/911)) ([bf937d0](https://github.com/misospace/pr-reviewer-action/commit/bf937d011786fc9c45a5be56220ed17489bd6648))

## [3.0.1](https://github.com/misospace/pr-reviewer-action/compare/source-v3.0.0...source-v3.0.1) (2026-09-30)


### Bug Fixes

* **release:** track a source-vX.Y.Z anchor so release-please finds the last release ([#907](https://github.com/misospace/pr-reviewer-action/issues/907)) ([443bf19](https://github.com/misospace/pr-reviewer-action/commit/443bf1998d61b87c47070103ccd84bee4582af5e))
* **v3:** read system-prompt-file from the base ref, not the run artifact dir ([#905](https://github.com/misospace/pr-reviewer-action/issues/905)) ([de5c628](https://github.com/misospace/pr-reviewer-action/commit/de5c628a9a73ce9cf27a5999e8f62be76364d33d))

## [3.0.0](https://github.com/misospace/pr-reviewer-action/compare/v2.5.0...v3.0.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* **review:** remove incremental-only escalation and review metadata state ([#618](https://github.com/misospace/pr-reviewer-action/issues/618)) (#645)
* **review:** remove carried findings and cross-run incremental evidence state ([#617](https://github.com/misospace/pr-reviewer-action/issues/617)) (#644)
* **review:** `review_scope`, `escalate_on_dirty_baseline`, `effective_review_scope`, `previous_head_sha`, and `baseline_clean` are removed; there is no replacement.

### Features

* **ci:** privilege-separated AI review for fork PRs ([#748](https://github.com/misospace/pr-reviewer-action/issues/748)) ([76d9baf](https://github.com/misospace/pr-reviewer-action/commit/76d9baf66fb266a8703893983b4efe11c072f410))
* **context:** anchor edits to their enclosing function ([#790](https://github.com/misospace/pr-reviewer-action/issues/790)) ([14a7cff](https://github.com/misospace/pr-reviewer-action/commit/14a7cffb45fc35aba3736ef6fcbce6523c1530bb))
* **context:** consumers of changed keys and referenced counterparts ([#795](https://github.com/misospace/pr-reviewer-action/issues/795)) ([6376583](https://github.com/misospace/pr-reviewer-action/commit/63765835070a1093318f5df608d4809d956a105a))
* **context:** current PR metadata outranks earlier discussion ([#812](https://github.com/misospace/pr-reviewer-action/issues/812)) ([f52f196](https://github.com/misospace/pr-reviewer-action/commit/f52f1966c39882bc3ab6d797a3bdeaaabf2c5353))
* **deep-review:** classifier-driven auto role selection ([#633](https://github.com/misospace/pr-reviewer-action/issues/633)) ([#655](https://github.com/misospace/pr-reviewer-action/issues/655)) ([3a1ea6f](https://github.com/misospace/pr-reviewer-action/commit/3a1ea6fdc9d7ff4a73b050393c635bb79ab37bdd))
* **deps:** update dependency @types/node (24.13.6 → 24.19.0) ([#760](https://github.com/misospace/pr-reviewer-action/issues/760)) ([77203aa](https://github.com/misospace/pr-reviewer-action/commit/77203aa9f27c64c990b02cf9e0ced5ed2c5b167a))
* **deps:** update dependency esbuild (0.25.5 → 0.28.2) ([#693](https://github.com/misospace/pr-reviewer-action/issues/693)) ([3f6bfbf](https://github.com/misospace/pr-reviewer-action/commit/3f6bfbfd8e75fadd46c82e08a0362241b1d1c196))
* **deps:** update dependency typescript (5.8.3 → 7.0.2) ([#696](https://github.com/misospace/pr-reviewer-action/issues/696)) ([1327d75](https://github.com/misospace/pr-reviewer-action/commit/1327d753cb46f8b91ec8da57294458c5a044248f))
* **eval:** blind adjudication tool for real-PR recall ([#841](https://github.com/misospace/pr-reviewer-action/issues/841)) ([#864](https://github.com/misospace/pr-reviewer-action/issues/864)) ([7dd6fcb](https://github.com/misospace/pr-reviewer-action/commit/7dd6fcbcfeaafc1d82139463304d481a35e1167b))
* **eval:** counterexample-falsification scoring and fixtures ([#757](https://github.com/misospace/pr-reviewer-action/issues/757)) ([#758](https://github.com/misospace/pr-reviewer-action/issues/758)) ([aaeac1f](https://github.com/misospace/pr-reviewer-action/commit/aaeac1fc70bd9275411b2aed264c5feb936842d3))
* **evals:** A/B specialist execution shapes ([#635](https://github.com/misospace/pr-reviewer-action/issues/635)) ([#691](https://github.com/misospace/pr-reviewer-action/issues/691)) ([ae8bb25](https://github.com/misospace/pr-reviewer-action/commit/ae8bb258026d878e0e30a7d12bb4a206c62a27a9))
* **evals:** add historical semantic regression corpus ([#627](https://github.com/misospace/pr-reviewer-action/issues/627)) ([#646](https://github.com/misospace/pr-reviewer-action/issues/646)) ([f86bf2c](https://github.com/misospace/pr-reviewer-action/commit/f86bf2cfb06fb9346d30aae575200cc1a017310a))
* **evals:** add PR [#654](https://github.com/misospace/pr-reviewer-action/issues/654) execution-boundary fixtures ([#659](https://github.com/misospace/pr-reviewer-action/issues/659)) ([#664](https://github.com/misospace/pr-reviewer-action/issues/664)) ([894f092](https://github.com/misospace/pr-reviewer-action/commit/894f092f2d4c5df00af68abbb153e720c1015299))
* **evals:** harvest maintainer findings into the human-findings corpus ([#798](https://github.com/misospace/pr-reviewer-action/issues/798)) ([#800](https://github.com/misospace/pr-reviewer-action/issues/800)) ([4ad14e8](https://github.com/misospace/pr-reviewer-action/commit/4ad14e86a7a455b0ae9ae4e382400ce003119279))
* **evals:** real-PR recall corpus ([#782](https://github.com/misospace/pr-reviewer-action/issues/782)) ([ea7649d](https://github.com/misospace/pr-reviewer-action/commit/ea7649dbc848754f6e8d25e75319acc0eff995f0))
* **platform:** resolve tangled platform and normalize Spindle runtime context ([#793](https://github.com/misospace/pr-reviewer-action/issues/793)) ([b8b1aa8](https://github.com/misospace/pr-reviewer-action/commit/b8b1aa85823f41548115549c049c930e09c75dc3))
* **publish:** resolve review threads of superseded managed reviews ([#769](https://github.com/misospace/pr-reviewer-action/issues/769)) ([6f5813a](https://github.com/misospace/pr-reviewer-action/commit/6f5813a42b0f418110abeaeb85f561218c8edcd6))
* **requirements:** harness-authored verification obligations in the ledger ([#796](https://github.com/misospace/pr-reviewer-action/issues/796)) ([#818](https://github.com/misospace/pr-reviewer-action/issues/818)) ([2a0d088](https://github.com/misospace/pr-reviewer-action/commit/2a0d08894bbf37d8ba61caf601bb7bf5490b2360))
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
* **tools:** stop rationing tool-loop evidence gathering ([#794](https://github.com/misospace/pr-reviewer-action/issues/794)) ([#797](https://github.com/misospace/pr-reviewer-action/issues/797)) ([373529e](https://github.com/misospace/pr-reviewer-action/commit/373529e455fa9047f3cd14b6fa6fc61b7e52002c))
* **tools:** structured budget telemetry for the native loop ([#709](https://github.com/misospace/pr-reviewer-action/issues/709)) ([7c26e6d](https://github.com/misospace/pr-reviewer-action/commit/7c26e6da2b1908268e2fb544c0ac4731059fcccf))
* **tools:** tier-aware, exhaustion-aware native-loop request budgets ([#707](https://github.com/misospace/pr-reviewer-action/issues/707)) ([e2ca972](https://github.com/misospace/pr-reviewer-action/commit/e2ca972cc764fc8715518169acc5bf5bf4aa5be7))
* **transport:** bound v3 model response buffering ([#745](https://github.com/misospace/pr-reviewer-action/issues/745)) ([#754](https://github.com/misospace/pr-reviewer-action/issues/754)) ([55b5762](https://github.com/misospace/pr-reviewer-action/commit/55b5762d8fca63dc3274bc64a9cc9df6067dc12d))
* **v3:** CI and specialists gate workloads ([#807](https://github.com/misospace/pr-reviewer-action/issues/807)) ([c504e51](https://github.com/misospace/pr-reviewer-action/commit/c504e51c4f19afca2ff3069b23a1e7b8017ae976))
* **v3:** clamp max_tokens to the provider's stated cap and retry once ([#825](https://github.com/misospace/pr-reviewer-action/issues/825)) ([7ba3463](https://github.com/misospace/pr-reviewer-action/commit/7ba34634b6f3522dff828f1935007356ea09b3d5))
* **v3:** consistent re-reviews: CI-aware skip and resolved-blocker gate ([#812](https://github.com/misospace/pr-reviewer-action/issues/812)) ([#817](https://github.com/misospace/pr-reviewer-action/issues/817)) ([6fcbe1e](https://github.com/misospace/pr-reviewer-action/commit/6fcbe1e04e5a1b1e587349dd59d613f83532f85d))
* **v3:** define kebab-case action contract ([#687](https://github.com/misospace/pr-reviewer-action/issues/687)) ([95c4039](https://github.com/misospace/pr-reviewer-action/commit/95c4039501bb01333543c00e67f9799929d62013))
* **v3:** deterministic context producers ([#805](https://github.com/misospace/pr-reviewer-action/issues/805)) ([eea90ba](https://github.com/misospace/pr-reviewer-action/commit/eea90ba9c0ebbc3effb1877d5700c4453edf08d6))
* **v3:** end-to-end TypeScript orchestrator and v2 shadow comparison ([#809](https://github.com/misospace/pr-reviewer-action/issues/809)) ([#814](https://github.com/misospace/pr-reviewer-action/issues/814)) ([d48b4f2](https://github.com/misospace/pr-reviewer-action/commit/d48b4f2f39246253bffb093cd57ede6dbed4fcb0))
* **v3:** evidence providers, SARIF, image transport ([#806](https://github.com/misospace/pr-reviewer-action/issues/806)) ([4777297](https://github.com/misospace/pr-reviewer-action/commit/47772971a30b8e4cc31651de399f23710ff6f588))
* **v3:** make harness obligations opt-in ([#796](https://github.com/misospace/pr-reviewer-action/issues/796)) ([#831](https://github.com/misospace/pr-reviewer-action/issues/831)) ([b7a6db4](https://github.com/misospace/pr-reviewer-action/commit/b7a6db46d72b13c193d8fc639588ac8eb2e344f7))
* **v3:** migrate classification, role selection, and requirement ledger to TypeScript ([#675](https://github.com/misospace/pr-reviewer-action/issues/675)) ([#708](https://github.com/misospace/pr-reviewer-action/issues/708)) ([39aa503](https://github.com/misospace/pr-reviewer-action/commit/39aa503cc736d45bfae9caeee22769d675ba558e))
* **v3:** migrate enforcement, managed metadata, publishing, and outputs ([#680](https://github.com/misospace/pr-reviewer-action/issues/680)) ([#778](https://github.com/misospace/pr-reviewer-action/issues/778)) ([db45c7e](https://github.com/misospace/pr-reviewer-action/commit/db45c7eeb5e4ad700bbeadf923aa82ece42ad872))
* **v3:** migrate platform adapters and precheck path to TypeScript ([#674](https://github.com/misospace/pr-reviewer-action/issues/674)) ([#705](https://github.com/misospace/pr-reviewer-action/issues/705)) ([567977e](https://github.com/misospace/pr-reviewer-action/commit/567977e0452b63222c09a740bf6fc5694b8e6a49))
* **v3:** migrate remaining [#675](https://github.com/misospace/pr-reviewer-action/issues/675) context scope to TypeScript ([#716](https://github.com/misospace/pr-reviewer-action/issues/716)) ([ff47ef3](https://github.com/misospace/pr-reviewer-action/commit/ff47ef36c68a4dd71a263a959e729bca5aa5c873))
* **v3:** opt-in claim falsification pass ([#785](https://github.com/misospace/pr-reviewer-action/issues/785)) ([#786](https://github.com/misospace/pr-reviewer-action/issues/786)) ([e95fbe6](https://github.com/misospace/pr-reviewer-action/commit/e95fbe614b59afc01d3f3f8883289fbf926e5ab6))
* **v3:** platform read seams ([#803](https://github.com/misospace/pr-reviewer-action/issues/803)) ([1e9dd0c](https://github.com/misospace/pr-reviewer-action/commit/1e9dd0c6f58abeb57b94fed0fac824a28f454e4b))
* **v3:** port change_anchors ([#802](https://github.com/misospace/pr-reviewer-action/issues/802)) ([7236aa4](https://github.com/misospace/pr-reviewer-action/commit/7236aa4b278f91646247583155ea188f55b8ac2d))
* **v3:** port corpus assembly to TypeScript ([#676](https://github.com/misospace/pr-reviewer-action/issues/676)) ([#746](https://github.com/misospace/pr-reviewer-action/issues/746)) ([37242e2](https://github.com/misospace/pr-reviewer-action/commit/37242e2721bee599e018da2d29969b9f9278268b))
* **v3:** port routing, escalation, conversation, and native tool loop ([#678](https://github.com/misospace/pr-reviewer-action/issues/678)) ([#761](https://github.com/misospace/pr-reviewer-action/issues/761)) ([7137b88](https://github.com/misospace/pr-reviewer-action/commit/7137b88e0e5874ba474d18936107ed52b70667ed))
* **v3:** port the deep-review specialists logic ([#776](https://github.com/misospace/pr-reviewer-action/issues/776)) ([#780](https://github.com/misospace/pr-reviewer-action/issues/780)) ([08bd1d1](https://github.com/misospace/pr-reviewer-action/commit/08bd1d10e14a658055a268d89ba9ca09283f9a57))
* **v3:** port the model call layer to typescript ([#703](https://github.com/misospace/pr-reviewer-action/issues/703)) ([309aabf](https://github.com/misospace/pr-reviewer-action/commit/309aabfd6fec55b226908094fcc534116c5e6d83))
* **v3:** production cutover to the TypeScript runtime ([#706](https://github.com/misospace/pr-reviewer-action/issues/706)) ([#815](https://github.com/misospace/pr-reviewer-action/issues/815)) ([f94bef8](https://github.com/misospace/pr-reviewer-action/commit/f94bef828391c9662da39a473d487e87576939b7))
* **v3:** prompt and message layer ([#804](https://github.com/misospace/pr-reviewer-action/issues/804)) ([ebb231a](https://github.com/misospace/pr-reviewer-action/commit/ebb231a206dfaa16d0e17db81ea57d22a24acdfc))
* **v3:** record tool-budget provenance in telemetry and the review marker ([#847](https://github.com/misospace/pr-reviewer-action/issues/847)) ([#865](https://github.com/misospace/pr-reviewer-action/issues/865)) ([c794392](https://github.com/misospace/pr-reviewer-action/commit/c794392e6062d8c92fc9b0a212ebefe407f4887a))
* **v3:** repository config, trim dead inputs ([#784](https://github.com/misospace/pr-reviewer-action/issues/784)) ([3cbfe6b](https://github.com/misospace/pr-reviewer-action/commit/3cbfe6b386500bc808108f98df7df2c8dbbbc66f))
* **v3:** scaffold typed runtime ([#689](https://github.com/misospace/pr-reviewer-action/issues/689)) ([77736bf](https://github.com/misospace/pr-reviewer-action/commit/77736bfb50636d9ec27b9278800db7f685968567))
* **v3:** size-scaled tool budget and honest partial coverage ([#810](https://github.com/misospace/pr-reviewer-action/issues/810)) ([#813](https://github.com/misospace/pr-reviewer-action/issues/813)) ([eec5bc7](https://github.com/misospace/pr-reviewer-action/commit/eec5bc72250ec8c1f488241d0254f54376b644e2))
* **v3:** SSRF-safe linked-source fetch and render ([#808](https://github.com/misospace/pr-reviewer-action/issues/808)) ([5ca8d80](https://github.com/misospace/pr-reviewer-action/commit/5ca8d803501c96d70cfe1fea06e7f53b7adf8d06))
* **v3:** strict verdict derived from open findings and coverage ([#811](https://github.com/misospace/pr-reviewer-action/issues/811)) ([#816](https://github.com/misospace/pr-reviewer-action/issues/816)) ([bf9ec54](https://github.com/misospace/pr-reviewer-action/commit/bf9ec5415c9f07117591e164306115664001c438))
* **v3:** tag findings outside the diff ([#781](https://github.com/misospace/pr-reviewer-action/issues/781)) ([9c9b103](https://github.com/misospace/pr-reviewer-action/commit/9c9b103fbda39e32912573bdbb17ba09905a7939))
* **v3:** thread re-emission keeps original severity; current metadata outranks earlier discussion ([#812](https://github.com/misospace/pr-reviewer-action/issues/812)) ([d21dc7d](https://github.com/misospace/pr-reviewer-action/commit/d21dc7d315545de7370956454b219947f65cb889))
* **v3:** typed gates, evidence, and lifecycle ([#717](https://github.com/misospace/pr-reviewer-action/issues/717)) ([709bb6f](https://github.com/misospace/pr-reviewer-action/commit/709bb6f4217ae26c8fecb016b9e4f03d859cdc5b))
* **verdict:** coverage, docs and style findings cannot block on their own ([#772](https://github.com/misospace/pr-reviewer-action/issues/772)) ([66cef8a](https://github.com/misospace/pr-reviewer-action/commit/66cef8a0dd21406810a0b51a9e814ae811a4a452))
* **verdict:** decisive finding first ([#773](https://github.com/misospace/pr-reviewer-action/issues/773)) ([6ac94c5](https://github.com/misospace/pr-reviewer-action/commit/6ac94c560c1adfd36090b326bfe0967565d87ecc))


### Bug Fixes

* **ci:** wall-bound GitHub gh api polling attempts ([#688](https://github.com/misospace/pr-reviewer-action/issues/688)) ([d6889b4](https://github.com/misospace/pr-reviewer-action/commit/d6889b42652dfe405454075b1eba8830379d847d))
* **classifier:** require a real untrusted-path surface for path handling ([#756](https://github.com/misospace/pr-reviewer-action/issues/756)) ([a3abef6](https://github.com/misospace/pr-reviewer-action/commit/a3abef68e916532643d6c8e8342f7678ad379721))
* **classifier:** stop misclassifying module imports as path handling ([#720](https://github.com/misospace/pr-reviewer-action/issues/720)) ([9931ac6](https://github.com/misospace/pr-reviewer-action/commit/9931ac6276db3d654824b051494db91d00ab02ec))
* **dogfood:** exercise all specialist roles ([#667](https://github.com/misospace/pr-reviewer-action/issues/667)) ([702675e](https://github.com/misospace/pr-reviewer-action/commit/702675e074abfb7a0c08bcbdf1f8d4a7646bb8e5))
* **dogfood:** make the v3 shadow actually run ([#819](https://github.com/misospace/pr-reviewer-action/issues/819)) ([91df3a0](https://github.com/misospace/pr-reviewer-action/commit/91df3a0e1ab01085e3bcfdf26105542ed890948c))
* **enforcement:** run thread settlement and carry original severity ([#812](https://github.com/misospace/pr-reviewer-action/issues/812)) ([7a7a35b](https://github.com/misospace/pr-reviewer-action/commit/7a7a35b6de5c2f03e8c9ee0eff433a26938f2385))
* **eval:** fail closed on an unusable pinned file manifest ([#833](https://github.com/misospace/pr-reviewer-action/issues/833)) ([ed873b2](https://github.com/misospace/pr-reviewer-action/commit/ed873b2dcfc4557d5424950b88331fe0bc9943d7))
* **eval:** fixtures are same-repo PRs; configurable review timeout ([#771](https://github.com/misospace/pr-reviewer-action/issues/771)) ([645feb6](https://github.com/misospace/pr-reviewer-action/commit/645feb60365e8b0545cc0e0d7f12026e0eec0eb0))
* **eval:** key adjudication scenarios by corpus entry id ([#893](https://github.com/misospace/pr-reviewer-action/issues/893)) ([#894](https://github.com/misospace/pr-reviewer-action/issues/894)) ([c5c1024](https://github.com/misospace/pr-reviewer-action/commit/c5c1024a09eb64c6eaa8d01abca13ee656da8228))
* **eval:** real-PR runs-per-mode, longer review timeout, bad corpus pin ([#860](https://github.com/misospace/pr-reviewer-action/issues/860)) ([062c498](https://github.com/misospace/pr-reviewer-action/commit/062c498b9bc8ca14611f833757bc79ccbbd54715))
* **eval:** seed pinned replays' file list from the pinned diff ([6cc1113](https://github.com/misospace/pr-reviewer-action/commit/6cc1113c165432bf9ca40ae41b259f2d8f6ed945))
* **eval:** seed pinned replays' file list from the pinned diff ([#833](https://github.com/misospace/pr-reviewer-action/issues/833)) ([c3db3c0](https://github.com/misospace/pr-reviewer-action/commit/c3db3c02ab4d6f7a08d8f101d4e48041f8b17420))
* **evals:** fail eval-harness when every run errors ([#714](https://github.com/misospace/pr-reviewer-action/issues/714)) ([05aaafe](https://github.com/misospace/pr-reviewer-action/commit/05aaafee26f714451a4efd9889dab61ffd59adba))
* **evals:** harvester review follow-ups ([#801](https://github.com/misospace/pr-reviewer-action/issues/801)) ([88b94fc](https://github.com/misospace/pr-reviewer-action/commit/88b94fc9f47c5cd0a92365eaa8252e52dec0eb03))
* **evals:** retain diffs for specialists fixtures ([#713](https://github.com/misospace/pr-reviewer-action/issues/713)) ([fd4d8cd](https://github.com/misospace/pr-reviewer-action/commit/fd4d8cd402dbb2ee4929d9ee707171f388ee9423))
* **evals:** triage the 13 anchor-check flags from [#861](https://github.com/misospace/pr-reviewer-action/issues/861) ([#877](https://github.com/misospace/pr-reviewer-action/issues/877)) ([60dbe1a](https://github.com/misospace/pr-reviewer-action/commit/60dbe1abd78193d20990c52b3669eb24e44e1b2e))
* **eval:** weekly summary reads per-mode rates from mode_summary ([#715](https://github.com/misospace/pr-reviewer-action/issues/715)) ([#744](https://github.com/misospace/pr-reviewer-action/issues/744)) ([4b17206](https://github.com/misospace/pr-reviewer-action/commit/4b17206388a96843cca204cee4d176a4da84f771))
* **image:** validate registry repository paths ([#724](https://github.com/misospace/pr-reviewer-action/issues/724)) ([864ffc1](https://github.com/misospace/pr-reviewer-action/commit/864ffc1a1bf8066b38a6cc328deda9422673f23c))
* keep reviewed checkout off python sys.path ([#788](https://github.com/misospace/pr-reviewer-action/issues/788)) ([4c630a5](https://github.com/misospace/pr-reviewer-action/commit/4c630a5ba2d385b17f1f7bf9bd7d536ce36ace62))
* **model:** guarantee at least one call attempt per tier ([#887](https://github.com/misospace/pr-reviewer-action/issues/887)) ([55eeaf8](https://github.com/misospace/pr-reviewer-action/commit/55eeaf802423cfaeaff1446f659e0d262d76a1ed))
* **native-loop:** consume recoverable verdict retry, no duplicate synthesis ([#637](https://github.com/misospace/pr-reviewer-action/issues/637)) ([#651](https://github.com/misospace/pr-reviewer-action/issues/651)) ([345351c](https://github.com/misospace/pr-reviewer-action/commit/345351c2bf2074b5480d574aef500ebe69f82163))
* **platform:** body-edit cutoff via GraphQL lastEditedAt; reapply [#812](https://github.com/misospace/pr-reviewer-action/issues/812) rule post-CI ([7a19eaf](https://github.com/misospace/pr-reviewer-action/commit/7a19eaf66b061511e53068fa8104c2af650a6d52))
* **platform:** one atomic body snapshot per metadata pass ([#812](https://github.com/misospace/pr-reviewer-action/issues/812) review) ([ac09f43](https://github.com/misospace/pr-reviewer-action/commit/ac09f437f50d790af98d706447e76a4fcfb80a3d))
* **platform:** valid PR-thread comment order ([#631](https://github.com/misospace/pr-reviewer-action/issues/631)) ([#649](https://github.com/misospace/pr-reviewer-action/issues/649)) ([d45a273](https://github.com/misospace/pr-reviewer-action/commit/d45a2737b6098bff3369a46d58c8c6911fd9eb6c))
* **precheck:** link issues referenced by PR title and non-closing body forms ([#879](https://github.com/misospace/pr-reviewer-action/issues/879)) ([e481bd6](https://github.com/misospace/pr-reviewer-action/commit/e481bd66de57f8e463a0f3229ca83a8b41175699)), closes [#872](https://github.com/misospace/pr-reviewer-action/issues/872)
* **precheck:** pin config reads to one fd ([#723](https://github.com/misospace/pr-reviewer-action/issues/723)) ([2ab2a3a](https://github.com/misospace/pr-reviewer-action/commit/2ab2a3a5b35ebe5a5e174fdf8399baef195979c8))
* **publish:** keep the endpoint URL out of published reviews ([#836](https://github.com/misospace/pr-reviewer-action/issues/836)) ([7a788da](https://github.com/misospace/pr-reviewer-action/commit/7a788da1bd2017774c66ff985a81469ca5a848f9))
* **redact:** use a non-alphanumeric marker for known-secret masking ([#888](https://github.com/misospace/pr-reviewer-action/issues/888)) ([939e0fc](https://github.com/misospace/pr-reviewer-action/commit/939e0fc35b480615a65f6a64a457c874dcef5cd6))
* **repo-map:** avoid auth filename backtracking ([#722](https://github.com/misospace/pr-reviewer-action/issues/722)) ([d70bc95](https://github.com/misospace/pr-reviewer-action/commit/d70bc952d863de3acd0a2c4216e32468717e4955))
* restore the reviewer's evidence gathering (v2 + v3) ([#759](https://github.com/misospace/pr-reviewer-action/issues/759)) ([339d998](https://github.com/misospace/pr-reviewer-action/commit/339d998b6e521776be51b02b08cb8800c574c4ad))
* **reviewer:** keep sanitizer redaction from garbling committed source ([#880](https://github.com/misospace/pr-reviewer-action/issues/880)) ([791c85f](https://github.com/misospace/pr-reviewer-action/commit/791c85ffdf4ade6f03707842ff943c6ce821f85d))
* **run:** streamed tool calls, tool cwd and specialist artifact root ([#820](https://github.com/misospace/pr-reviewer-action/issues/820)) ([515943e](https://github.com/misospace/pr-reviewer-action/commit/515943e282c2ef893ffaf0a3b7a1bff9abb108bd))
* **standards:** resolve the standards file from the base ref, not PR head ([#890](https://github.com/misospace/pr-reviewer-action/issues/890)) ([59d93f2](https://github.com/misospace/pr-reviewer-action/commit/59d93f2cc237313f328fe0a9fa81ebbe6f1f30af))
* **tests:** clear .test-build and make git operations hermetic ([#858](https://github.com/misospace/pr-reviewer-action/issues/858)) ([27d4b95](https://github.com/misospace/pr-reviewer-action/commit/27d4b9510596b5baba8457e0ff74299b01032009))
* **tool-loop:** honour an empty ai_temperature on native_loop planning turns ([#747](https://github.com/misospace/pr-reviewer-action/issues/747)) ([8f3c0a6](https://github.com/misospace/pr-reviewer-action/commit/8f3c0a68fe42c16bb63b92d230df46e3d1854f09))
* **tooling:** refuse redirects on token-bearing HTTP calls ([#859](https://github.com/misospace/pr-reviewer-action/issues/859)) ([860b56d](https://github.com/misospace/pr-reviewer-action/commit/860b56d6df7a637f92586a533b1bb1951137db25))
* **tools:** keep tool-harness.json valid under redaction and fail closed when unreadable ([#899](https://github.com/misospace/pr-reviewer-action/issues/899)) ([#900](https://github.com/misospace/pr-reviewer-action/issues/900)) ([97f0b0d](https://github.com/misospace/pr-reviewer-action/commit/97f0b0dc0e3e391b96cb10ce42a0748bf303778b))
* **tools:** scale loop round cap with the tool budget ([#895](https://github.com/misospace/pr-reviewer-action/issues/895)) ([#897](https://github.com/misospace/pr-reviewer-action/issues/897)) ([a98bdf5](https://github.com/misospace/pr-reviewer-action/commit/a98bdf5d0925dc9dc43cff85d8e738fe8ad983d2))
* **transport:** surface HTTP status and body detail on model-call errors ([#862](https://github.com/misospace/pr-reviewer-action/issues/862)) ([ec25b3f](https://github.com/misospace/pr-reviewer-action/commit/ec25b3fd72ba2cd31574205ef658d53512de49f9))
* **v3:** mask secrets in model errors carried by a 200 reply ([#868](https://github.com/misospace/pr-reviewer-action/issues/868)) ([#869](https://github.com/misospace/pr-reviewer-action/issues/869)) ([ae72527](https://github.com/misospace/pr-reviewer-action/commit/ae72527ce3f3b5e262b81c06d31de2f3a0cbc82f))
* **v3:** normalize labeled-event shape so ai-review forces a re-review ([#896](https://github.com/misospace/pr-reviewer-action/issues/896)) ([241dd2d](https://github.com/misospace/pr-reviewer-action/commit/241dd2d764be4c0db6f61f57f6fd01666c4a6052))
* **v3:** publish the model-failure notice as request_changes ([#863](https://github.com/misospace/pr-reviewer-action/issues/863)) ([#866](https://github.com/misospace/pr-reviewer-action/issues/866)) ([fb49242](https://github.com/misospace/pr-reviewer-action/commit/fb4924221dada0cc8fe7dc9a669372a3eb526e34))
* **v3:** run never reads artifacts from the PR checkout ([#838](https://github.com/misospace/pr-reviewer-action/issues/838)) ([#870](https://github.com/misospace/pr-reviewer-action/issues/870)) ([6080648](https://github.com/misospace/pr-reviewer-action/commit/60806486eb1f6aee684206ed6655fe8ea143d0da))
* **verdict:** make non-blocking finding categories opt-in ([#775](https://github.com/misospace/pr-reviewer-action/issues/775)) ([1b83be8](https://github.com/misospace/pr-reviewer-action/commit/1b83be80c4c326f6c9ef00d2daaf97b670065afa))
* **verdict:** repair invalid escapes before accepting a partial candidate ([#767](https://github.com/misospace/pr-reviewer-action/issues/767)) ([d9b1a12](https://github.com/misospace/pr-reviewer-action/commit/d9b1a12cbded169dae07a2ebb50646a084879b1d))


### Chores

* clear code-scanning alerts before v3.0.0 ([#891](https://github.com/misospace/pr-reviewer-action/issues/891)) ([6c35674](https://github.com/misospace/pr-reviewer-action/commit/6c35674c53f2dd19065be8ff98e2674f237dece1))
* remove orphaned .candidates.json from repository root ([#822](https://github.com/misospace/pr-reviewer-action/issues/822)) ([#834](https://github.com/misospace/pr-reviewer-action/issues/834)) ([20fd562](https://github.com/misospace/pr-reviewer-action/commit/20fd5623b3d8070d66ce857bdd41cac0aeace4d3))
* **v3:** wave 2 teardown: freeze parity on v2 goldens, delete the remaining v2 code ([#681](https://github.com/misospace/pr-reviewer-action/issues/681)) ([#853](https://github.com/misospace/pr-reviewer-action/issues/853)) ([a8c4d14](https://github.com/misospace/pr-reviewer-action/commit/a8c4d1487fd470b36afb1fe174e349fae18f6694))


### Documentation

* add a v2 to v3 upgrade guide ([#857](https://github.com/misospace/pr-reviewer-action/issues/857)) ([7a018e3](https://github.com/misospace/pr-reviewer-action/commit/7a018e391ea49c65bfe9ec066fec9a811ca9f267))
* **agents:** slim AGENTS.md to durable rules, move detail to docs ([#751](https://github.com/misospace/pr-reviewer-action/issues/751)) ([#753](https://github.com/misospace/pr-reviewer-action/issues/753)) ([85ae3c3](https://github.com/misospace/pr-reviewer-action/commit/85ae3c375cae3ef62bdf77ba139c5f142d8168ab))
* **architecture:** keep three_call specialist shape on benchmark evidence ([#704](https://github.com/misospace/pr-reviewer-action/issues/704)) ([#710](https://github.com/misospace/pr-reviewer-action/issues/710)) ([4403d62](https://github.com/misospace/pr-reviewer-action/commit/4403d62708dd0578d73377a570ebcb6081e1efba))
* **runtime:** choose composite Node boundary ([#682](https://github.com/misospace/pr-reviewer-action/issues/682)) ([3a362a2](https://github.com/misospace/pr-reviewer-action/commit/3a362a2f19ed61a3db2affc1fa62e0620786604e))
* v3 examples and kebab-case input names ([#848](https://github.com/misospace/pr-reviewer-action/issues/848), [#850](https://github.com/misospace/pr-reviewer-action/issues/850), [#851](https://github.com/misospace/pr-reviewer-action/issues/851)) ([#849](https://github.com/misospace/pr-reviewer-action/issues/849)) ([cd0d29c](https://github.com/misospace/pr-reviewer-action/commit/cd0d29ce91d47ed135e3ee619bd3924a5c5ccff6))
* **v3-migration:** record the thread-severity and superseded-discussion change ([04fa6ee](https://github.com/misospace/pr-reviewer-action/commit/04fa6ee8c7eb65a54bc7d254e3cd8dfc06d1d8e6))
* **v3:** plan the v2 teardown file-by-file ([#706](https://github.com/misospace/pr-reviewer-action/issues/706)) ([#827](https://github.com/misospace/pr-reviewer-action/issues/827)) ([61314cc](https://github.com/misospace/pr-reviewer-action/commit/61314cc57a908675d826cbc5a082c812d10a3cbb))


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
