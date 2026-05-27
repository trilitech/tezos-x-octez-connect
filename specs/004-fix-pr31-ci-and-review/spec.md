# Feature Specification: PR #31 CI Failures & Review Comment Remediation

**Feature Branch**: `004-fix-pr31-ci-and-review`

**Created**: 2026-05-22

**Status**: Draft

**Input**: User description: "the octez.connect pull request is failing the CI and the github copilot ai review has given certain comments on the pull request. Please fix all the pr comments and CI fixes. https://github.com/trilitech/octez.connect/pull/31"

## Clarifications

### Session 2026-05-22

- Q: When `compareBeaconVersion()` is called with a malformed `peer.version`, how should it signal rejection? → A: Throw a typed error (`InvalidBeaconVersionError`). Every call site is responsible for wrapping in `try/catch` and translating into its own routing/gating outcome. The wallet interceptor (FR-005) MUST `try/catch` and treat a thrown malformed version as below the v4 threshold (legacy route). The dApp version-gating helpers MAY let it propagate (it indicates a corrupted persisted peer record, which is a hard error worth surfacing).
- Q: How should the C10 `accountId`-derivation mismatch in Tezos be fixed? → A: dApp-side only. `TezosBlockchain.getAccountInfosFromPermissionResponse()` recomputes the `accountId` at materialisation time by calling `getAccountIdentifier(address, network)` — the same scheme used by `PermissionValidator` and `OutgoingResponseInterceptor`. The v4 wire format does NOT change. The wallet side does NOT change. Companion PR `trilitech/tezos-x-octez-connect#4` is unaffected. (Parity with Substrate/Sapling — where the wallet stamps an explicit `accountId` — is left as a possible future cleanup, out of scope here.)
- Q: How should the SDK handle stale on-disk `PermissionInfo` entries derived under the pre-C10-fix scheme? → A: Force re-pair with a clear typed error. When `PermissionValidator` misses on a v4 Tezos lookup that would have hit under the old scheme, the SDK MUST throw a typed `StalePermissionSchemeError` instructing the user/dApp to re-pair. The remediation does NOT migrate existing entries (the v4 audience is internal-only on this branch; the smallest, safest fix is to fail loudly and force re-pairing). The error message MUST name the chain id, the address, and a recommended next step.
- Q: Should the wallet emit an observability signal when it rejects a malformed `peer.version`? → A: Log at `warn` level via the existing SDK `logger`. The log line MUST include the offending `peerVersion` value and the sender peer id. No new metric is added — the SDK has no current metrics surface to plug into, and `logger.warn` is enough to make the case visible during debugging while keeping hostile probing observable.

## Context

Pull request `trilitech/octez.connect#31` ("Multi-network support for Tezos X") stacks two spec increments (002 peer-version-handshake + 003 multi-network-protocol) onto the SDK. As of run `26294959547` (head `cf757e6`), the PR is **MERGEABLE** but both required CI jobs are **FAILED**:

1. **build-and-unit** → step `Gate new lint findings` reports **46 new lint errors** on touched lines across 5 packages (`octez.connect-blockchain-substrate`, `octez.connect-blockchain-tezos-sapling`, `octez.connect-blockchain-tezos`, `octez.connect-core`, `octez.connect-dapp`, `octez.connect-wallet`). The gate exits 1, blocking merge.
2. **end-to-end** → `e2e/wc-flow.spec.ts:17 "should load activeAccount on page reload"` times out (WC pairing handshake never reveals `#activeAccount`) on the initial run and all three retries; the `test.afterEach` hook then crashes with `TypeError: dappCtx.close is not a function`, masking the real failure and corrupting subsequent runs.

Independently, the GitHub Copilot AI reviewer left **11 inline comments** (some duplicates) flagging substantive correctness and type-safety concerns that overlap with — but extend beyond — the lint gate. The most material are:

- **Floating-promise / DoS** in `IncomingRequestInterceptor.intercept()` (comments C1, C9): async handlers called without `await`, and `compareBeaconVersion` invoked on an untrusted envelope value without a guard.
- **Loose version parsing** in `compareBeaconVersion()` (C2, C8): accepts `"4.1"`, `"4e0"`, `" 4 "` despite the contract requiring strict decimal-integer strings.
- **Missing barrel export** of `RequestPermissionNetwork` (C3).
- **`(request as any).networks` escape hatch** in `DAppClient.requestPermissions()` (C4) — the on-wire `PermissionRequest`/`PermissionRequestInput` types never grew the new field.
- **Misleading docstring** on `requiredMinimumVersion` in `DAppClientOptions.ts` (C5) — says `walletResponse.version`, but the implementation sources from `peer.version`.
- **Missing unit tests** for `requiredMinimumVersion` validation/enforcement (C6) and for v4 multi-network permission fanout + FR-019 defensive gate (C11).
- **Duplicate version assertion** in `requestPermissions()` (C7): `getPeer()` already asserts, the call site asserts again.
- **`accountId` derivation mismatch** in `TezosBlockchain.getAccountInfosFromPermissionResponse` (C10): uses `deriveAccountId(publicKey, chainId)` while `PermissionValidator` and `OutgoingResponseInterceptor` use `getAccountIdentifier(address, network)`, breaking permission lookup for Tezos operation requests under v4.

PR #31 cannot merge until both CI jobs go green. Copilot comments that overlap with the lint gate are resolved as a side-effect of fixing the gate; comments that are substantive correctness concerns (C5, C6, C7, C10, C11, and the runtime-resilience portion of C9) require additional work beyond passing lint.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Restore the merge gate so PR #31 can ship (Priority: P1)

The PR author needs both required CI jobs (`build-and-unit` and `end-to-end`) on the `cf757e6` head — and any subsequent push to the same branch — to report `conclusion: SUCCESS` so that the branch protection rule on `trilitech/octez.connect` master allows merge.

**Why this priority**: Without a green CI, the multi-network change cannot land. Every downstream artifact (the reference-apps companion PR `trilitech/tezos-x-octez-connect#4`, the integration guide, the public demo branch, the npm publish) is blocked on PR #31 merging. This is the critical path.

**Independent Test**: A reviewer can push a follow-up commit to `feat/peer-version-handshake` and observe in the GitHub Checks tab that `build-and-unit` and `end-to-end` both end in green within the workflow's normal duration (≤ ~10 min combined), with no skipped or neutral conclusions on the required checks.

**Acceptance Scenarios**:

1. **Given** the PR head commit contains the remediation, **When** GitHub Actions runs the CI workflow, **Then** `build-and-unit` completes successfully with the `Gate new lint findings` step reporting `0 new finding(s)`.
2. **Given** the PR head commit contains the remediation, **When** GitHub Actions runs the CI workflow, **Then** `end-to-end` completes successfully with `wc-flow.spec.ts` either passing on first attempt or — if the underlying WalletConnect flake is pre-existing on `master` — being explicitly skipped or quarantined with a written justification linked to the upstream flake.
3. **Given** the PR head commit contains the remediation, **When** a reviewer opens the PR, **Then** the merge button is enabled (no required checks failing, no merge conflicts).

---

### User Story 2 - Address every Copilot review comment so the human reviewer has nothing left to relitigate (Priority: P1)

The PR has 11 unresolved inline comments from the Copilot AI reviewer covering correctness, type-safety, runtime resilience, missing tests, and documentation accuracy. Each one must either be (a) fixed in code, or (b) explicitly resolved with a reply explaining why the existing code is correct as-is, before a human maintainer agrees to merge.

**Why this priority**: Several Copilot findings (especially C9 floating promise + DoS risk, C10 accountId mismatch, C8/C2 loose version parsing) describe behaviors that would degrade the SDK's runtime correctness under hostile or malformed input from peers. Shipping them unresolved risks regressions for every dApp on v4. Equally important: leaving the comments open signals to the human maintainer that the AI review wasn't taken seriously, which costs trust and slows future reviews.

**Independent Test**: A maintainer can open the "Files changed" tab of PR #31 and verify that every Copilot inline comment is either marked "Resolved" by the PR author with a corresponding code change in the diff, or has a substantive reply explaining the decision to not change the code. No Copilot thread should remain "Unresolved" and unanswered.

**Acceptance Scenarios**:

1. **Given** Copilot comment C1/C9 on `IncomingRequestInterceptor.ts:88-93`, **When** the file is re-reviewed, **Then** the chosen async handler is invoked with `await` (or `return await`) so rejections propagate and no floating promise is created, AND the call to `compareBeaconVersion(peerVersion, MULTI_NETWORK_FROM_VERSION)` is guarded so a malformed `peerVersion` does not crash the wallet's request pipeline.
2. **Given** Copilot comment C2/C8 on `message-utils.ts:35`, **When** `compareBeaconVersion()` is called with `"4.1"`, `"4e0"`, `" 4 "`, `"04"`, `""`, `"-1"`, or `undefined`, **Then** the function throws `InvalidBeaconVersionError`, the wallet interceptor's `try/catch` translates it into a legacy-branch routing decision (FR-005), and a unit test covers each malformed-input case + the wallet's translation behaviour.
3. **Given** Copilot comment C3 on `RequestPermissionInput.ts:31`, **When** an SDK consumer imports `RequestPermissionNetwork` from `@tezos-x/octez.connect-types`, **Then** the type resolves from the package root barrel, not a deep path.
4. **Given** Copilot comment C4 on `DAppClient.ts:1679`, **When** the outgoing `PermissionRequest` is constructed, **Then** the `networks` field is set via a typed property on `PermissionRequest`/`PermissionRequestInput` (declared in `@tezos-x/octez.connect-types`), with no `as any` cast at the assignment site.
5. **Given** Copilot comment C5 on `DAppClientOptions.ts:167`, **When** an integrator reads the JSDoc for `requiredMinimumVersion`, **Then** the doc accurately states that the SDK compares against the persisted `peer.version` (sourced from `PeerManager`), not against any inner `message.version` field.
6. **Given** Copilot comment C6 on `DAppClient.ts:193`, **When** the dApp Jest suite runs, **Then** it includes positive and negative cases for: (a) invalid `requiredMinimumVersion` → `InvalidRequiredMinimumVersionError`, (b) omitted `requiredMinimumVersion` → defaults to `BEACON_VERSION`, (c) wallet `peer.version` below `requiredMinimumVersion` → `VersionUnsupportedBeaconError`.
7. **Given** Copilot comment C7 on `DAppClient.ts:1715`, **When** `requestPermissions()` resolves a peer, **Then** the wallet-version assertion runs exactly once per request — either inside `getPeer()` or at the call site, not both.
8. **Given** Copilot comment C10 on `blockchain.ts:99`, **When** a Tezos v4 permission response is materialised into `AccountInfo` records, **Then** each record's `accountId` is derived using the same scheme as `getAccountIdentifier(address, network)` used by `PermissionValidator` and `OutgoingResponseInterceptor`, so a subsequent `OperationRequest` permission lookup hits the persisted `PermissionInfo`.
9. **Given** Copilot comment C11 on `DAppClient.ts:1704`, **When** the dApp Jest suite runs, **Then** it includes cases for: (a) v4 multi-network permission response with N accounts → N `AccountInfo` records persisted, (b) v4 response missing the `accounts[]` fanout for a ≥2-network request with `requiredMinimumVersion >= '4'` → `NetworksUnsupportedBeaconError` (FR-019 defensive gate).

---

### User Story 3 - Keep the behavioural contract of spec 002 + spec 003 intact while applying the fixes (Priority: P2)

Existing dApps using the legacy v3 single-network flow, and the new multi-network e2e cell already validated against ghostnet + Tezos X previewnet, must continue to work byte-for-byte after the remediation. No remediation step may regress the backward-compatibility matrix documented in the PR body.

**Why this priority**: PR #31 already passed manual e2e validation against real networks (per the PR body "Multi-network e2e cell green against real ghostnet + Tezos X previewnet"). Refactoring `accountId` derivation (C10), tightening version parsing (C2/C8), and changing handler awaiting (C1/C9) all touch hot paths that could silently break the demo branch and the companion PR `tezos-x-octez-connect#4`. Without an explicit regression guard, the lint fixes ship but the demo breaks.

**Independent Test**: After the remediation, the existing e2e suites (`base-flow`, `p2p-flow`) continue to pass without modification, AND the multi-network e2e cell in `tezos-x-octez-connect#4` (matrix-P2P, two ops on two chains in one session) continues to complete green on the same testnets it was last validated against.

**Acceptance Scenarios**:

1. **Given** a legacy v3 dApp paired with a v4 wallet, **When** the dApp sends `requestPermissions` without `networks`, **Then** the wallet responds with a single-network v3-shaped payload and the dApp materialises exactly one `AccountInfo` (the existing `getAccounts()`-based path), unchanged from pre-remediation behaviour.
2. **Given** a v4 dApp paired with a v4 wallet across two networks, **When** the dApp sends `requestPermissions({ networks: [tezosL1, tezosXL2] })`, **Then** the resulting `accountInfos` array contains exactly two records, each keyed by an `accountId` that a subsequent `requestOperation({ network })` can resolve via `PermissionValidator` without `MissingPermissionError`.
3. **Given** a v4 dApp with `requiredMinimumVersion = '4'`, **When** it pairs with a wallet whose persisted `peer.version` is `'3'`, **Then** the SDK throws `VersionUnsupportedBeaconError` (same behaviour as before, just via the consolidated single assertion path from C7).
4. **Given** the existing 24 passing e2e tests (`base-flow.spec.ts`, `p2p-flow.spec.ts`), **When** the workflow runs against the remediation head, **Then** all 24 continue to pass.

---

### Edge Cases

- **Pre-existing WC-flow flake vs. regression**: the `wc-flow.spec.ts:17` failure log shows a 30s timeout waiting on `#activeAccount`, indistinguishable in symptom from a relay-layer flake. The remediation must determine whether the failure is reproducible on `master` (pre-existing, then quarantine with citation) or specific to this branch's wallet-side `peer.version` routing change (then fix the routing). It must not be silently ignored.
- **Broken `afterEach` hook**: `TypeError: dappCtx.close is not a function` in `wc-flow.spec.ts:14` is an independent bug — `dappCtx` is the wrong shape — that masks the real WC error and pollutes the next retry. It must be fixed regardless of the WC timeout outcome.
- **Malformed `peer.version` from a hostile peer**: a peer that stamps `peer.version = "<script>"` or `"NaN"` must not crash the wallet's request pipeline (C9). The wallet must treat unparseable versions as below-threshold and reject/ignore cleanly.
- **Persisted PermissionInfo on disk from before the fix**: if a Tezos user paired under v4 before C10 is fixed, the on-disk `PermissionInfo.accountIdentifier` was derived via the wrong scheme. Resolution (per Clarifications, Session 2026-05-22): the SDK throws a typed `StalePermissionSchemeError` on lookup miss, instructing the user to re-pair. No automatic migration is performed.
- **Existing call sites of `compareBeaconVersion()`**: if the function's contract changes from "throws on malformed" to "returns sentinel" (or vice versa), every call site must be audited. A partial change leaves the SDK in an inconsistent state.
- **Lint findings introduced by the fix itself**: the remediation must not, in fixing the 46 listed errors, introduce new ones (e.g., suppressing one `any` by widening another with `unknown` and an unsafe cast). The CI `lint:new` gate will catch this, but the author should verify locally first.

## Requirements *(mandatory)*

### Functional Requirements

**CI gate restoration (P1):**

- **FR-001**: The `lint:new` script on the PR head MUST report `0 new finding(s)` against `master`. Each of the 46 reported errors in `26294959547` (covering `@typescript-eslint/no-unused-vars`, `@typescript-eslint/no-explicit-any`, `prefer-arrow/prefer-arrow-functions`, `padding-line-between-statements`, `@typescript-eslint/no-use-before-define`, `@typescript-eslint/no-non-null-assertion`, `@typescript-eslint/no-unnecessary-type-assertion`, `@typescript-eslint/no-floating-promises`, `@typescript-eslint/array-type`, `curly`) MUST be resolved by code change, not by `eslint-disable` suppression, unless a per-line suppression is accompanied by an inline comment justifying why the rule is wrong in that exact context.
- **FR-002**: The `end-to-end` job on the PR head MUST conclude `SUCCESS`. The `dappCtx.close is not a function` afterEach failure in `e2e/wc-flow.spec.ts` MUST be fixed (the hook MUST close the actual page contexts owned by the test, with the correct shape, regardless of WC pairing outcome).
- **FR-003**: If the `wc-flow.spec.ts:17 "should load activeAccount on page reload"` failure is reproducible on the current `master` HEAD (pre-existing flake), the test MAY be temporarily quarantined (`.skip` + comment referencing the master-side incident and the follow-up issue). If it is reproducible only on this branch, the underlying regression in WC routing under v4 peer-version handling MUST be fixed.

**Copilot comment remediation (P1):**

- **FR-004**: `IncomingRequestInterceptor.intercept()` MUST `await` (or `return await`) the selected handler (`handleV2Message` / `handleV3Message` / `handleV4Message`) so the returned promise reflects handler completion and rejections propagate to the caller (C1).
- **FR-005**: `IncomingRequestInterceptor.intercept()` MUST guard the `compareBeaconVersion(peerVersion, MULTI_NETWORK_FROM_VERSION)` call against malformed `peerVersion` values from untrusted peers by wrapping the call in `try/catch`. A thrown `InvalidBeaconVersionError` (or any error propagating out of `compareBeaconVersion`) MUST be treated as below the v4 threshold and routed via the legacy branch — the exception MUST NOT propagate to `WalletClient.handleResponse`. The catch block MUST also emit a single `logger.warn(...)` line carrying the offending `peerVersion` value and the sender peer id so the rejection is visible in debug traces; no metric is required (C9).
- **FR-006**: `compareBeaconVersion()` in `octez.connect-core/src/utils/message-utils.ts` MUST validate both operands as strict decimal-integer strings (`/^\d+$/`, with a safe-integer upper bound) before comparison; non-matching inputs (`"4.1"`, `"4e0"`, `" 4 "`, `"04"`, `""`, `null`, `undefined`, leading sign, NaN) MUST be rejected by **throwing** a typed `InvalidBeaconVersionError` (registered alongside the existing version-related errors in `@tezos-x/octez.connect-core`). Every existing call site MUST be audited and either wrap the call in `try/catch` to translate the throw into a routing/gating decision (wallet interceptor per FR-005), or let it propagate as a hard error (dApp version-gating helpers, where the value originates from the persisted `PeerManager` record and a malformed value indicates corruption worth surfacing) (C2, C8).
- **FR-007**: `RequestPermissionNetwork` (and any other v4 public types that consumers need to populate `RequestPermissionInput.networks`) MUST be re-exported from the `@tezos-x/octez.connect-types` package barrel (`src/index.ts`) so consumers can import via the package root without deep imports (C3).
- **FR-008**: `PermissionRequest` and `PermissionRequestInput` in `@tezos-x/octez.connect-types` MUST declare an optional typed `networks?: RequestPermissionNetwork[]` field. The assignment site in `DAppClient.requestPermissions()` MUST set it via the typed property — no `(request as any).networks` cast (C4).
- **FR-009**: The JSDoc for `DAppClientOptions.requiredMinimumVersion` MUST state that the SDK compares against the persisted `peer.version` (from `PeerManager`), not against any inner `message.version` field, matching the implementation in `assertWalletVersionMeetsMinimum` (C5).
- **FR-010**: The wallet-version assertion in `DAppClient.requestPermissions()` MUST run exactly once per request. The duplicated assertion between `getPeer()` and the immediately-following `assertWalletVersionMeetsMinimum(walletPeerVersion)` MUST be consolidated — either by removing the second call, or by introducing a `getPeerWithoutAsserting()` helper used at sites that need the version without the side effect (C7).
- **FR-011**: `TezosBlockchain.getAccountInfosFromPermissionResponse()` MUST derive each materialised `AccountInfo.accountId` by calling `getAccountIdentifier(address, network)` — the same scheme used by `PermissionValidator` and `OutgoingResponseInterceptor` — so a subsequent `OperationRequest` permission lookup resolves successfully. The fix is dApp-side only: the v4 wire format MUST NOT change and the wallet implementation MUST NOT change as part of this remediation (C10).
- **FR-011a**: When `PermissionValidator` cannot resolve a v4 Tezos `OperationRequest` against any persisted `PermissionInfo`, but a stale entry exists at the same `(address, chainId)` derived under the pre-C10 scheme, the SDK MUST throw a typed `StalePermissionSchemeError`. The error MUST carry the address, the chain id, and a recommended next step ("re-pair this dApp with the wallet"). The remediation MUST NOT auto-migrate stale entries.
- **FR-012**: The `@tezos-x/octez.connect-dapp` Jest suite (`packages/octez.connect-dapp/__tests__/dapp-client/DAppClient.test.ts`) MUST cover: (a) invalid `requiredMinimumVersion` → `InvalidRequiredMinimumVersionError`, (b) omitted `requiredMinimumVersion` → defaults to `BEACON_VERSION`, (c) wallet `peer.version` below `requiredMinimumVersion` → `VersionUnsupportedBeaconError` (C6).
- **FR-013**: The `@tezos-x/octez.connect-dapp` Jest suite MUST cover: (a) v4 multi-network permission response with N accounts → N `AccountInfo` records, (b) v4 response missing `accounts[]` fanout for a ≥2-network request with `requiredMinimumVersion >= '4'` → `NetworksUnsupportedBeaconError` (FR-019 defensive gate) (C11).

**Behavioural-contract preservation (P2):**

- **FR-014**: The backward-compatibility matrix in the PR body (legacy v3 dApp ↔ v3 wallet; legacy v3 dApp ↔ v4 wallet served as `'3'`; v4 dApp ↔ v4 wallet multi-network; v4 dApp ↔ v3 wallet → `VersionUnsupportedBeaconError`; v4 multi-network ↔ v4 wallet missing `accounts[]` → `NetworksUnsupportedBeaconError`; v4 wallet emits wire-level `NETWORK_NOT_SUPPORTED`) MUST hold byte-for-byte after remediation. Any change to `compareBeaconVersion` semantics or `accountId` derivation MUST be verified against this matrix.
- **FR-015**: The 24 existing `base-flow` and `p2p-flow` e2e cells MUST continue to pass on the PR head with no modifications to the test files (beyond fixing the broken `afterEach` and, if applicable, quarantining `wc-flow.spec.ts:17`).
- **FR-016**: The multi-network e2e cell in companion PR `trilitech/tezos-x-octez-connect#4` (matrix-P2P, two ops on two chains in one session) MUST continue to pass against the same testnets it was last validated against, after this branch is updated to point to the remediated SDK head.

**Process / hygiene:**

- **FR-017**: After resolving each Copilot comment, the PR author MUST mark the corresponding thread "Resolved" on GitHub, with a brief reply pointing at the commit SHA that addressed it. Threads where the author disagrees with Copilot MUST be replied to with the reasoning (not silently closed).
- **FR-018**: No lint suppression (`// eslint-disable-...`) MAY be introduced as a remediation shortcut without an inline comment naming the rule and stating why the rule is incorrect for that specific line.

### Key Entities *(include if feature involves data)*

- **PR #31 (`trilitech/octez.connect#31`)**: the pull request whose CI must go green. Head ref `feat/peer-version-handshake`, base `master`. Title "Multi-network support for Tezos X". Current state OPEN / MERGEABLE / failing required checks.
- **Copilot review thread**: 11 unresolved inline comments authored by the GitHub Copilot AI reviewer. Each thread is keyed by `path:line` and must end in either a code fix or a substantive reply.
- **`lint:new` CI gate**: the `node scripts/lint-new-findings.mjs` script that ESLints only the lines touched by the PR vs. `PR_BASE_SHA`. Exits 1 if any new findings exist on touched lines. Source of the 46 reported errors.
- **`compareBeaconVersion` contract**: a documented function in `@tezos-x/octez.connect-core/src/utils/message-utils.ts` whose contract (decimal-integer strings, malformed → rejected) is currently weaker than its docstring. Used by both the wallet interceptor and the dApp version-gating helpers.
- **`PermissionInfo.accountIdentifier`**: the disk-persisted key under which the dApp looks up permission grants when serving `OperationRequest`. Currently derived inconsistently between materialisation (Tezos blockchain) and lookup (`PermissionValidator`).
- **Backward-compatibility matrix**: the 6-row table in the PR body describing every `(dApp peer.version, wallet served peer.version)` cell and its expected behaviour. The acceptance contract for FR-014.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: PR #31 reaches `conclusion: SUCCESS` on both required CI jobs (`build-and-unit` and `end-to-end`) within one CI run after the remediation is pushed, with no required check skipped.
- **SC-002**: All 11 Copilot inline comments on PR #31 are marked "Resolved" — every thread either points to a remediation commit SHA or carries a substantive author reply justifying the decision to not change the code.
- **SC-003**: The `lint:new` CI step reports `0 new finding(s)` on touched lines, down from the current 46.
- **SC-004**: The PR can be merged into `master` via the standard GitHub merge button (no admin override needed, no failing required checks, no merge conflicts) on the first attempt after remediation is pushed.
- **SC-005**: The full dApp Jest suite (`packages/octez.connect-dapp/__tests__/dapp-client/DAppClient.test.ts`) gains ≥ 5 new test cases (3 for `requiredMinimumVersion`, 2 for v4 multi-network permission fanout / FR-019), all passing on the remediation head.
- **SC-006**: The 24 existing e2e cells in `base-flow.spec.ts` and `p2p-flow.spec.ts` continue to pass on the remediation head, with no test-file modifications beyond the `afterEach` fix and any explicit `wc-flow.spec.ts` quarantine.
- **SC-007**: A targeted re-run of the multi-network e2e cell from `trilitech/tezos-x-octez-connect#4` against ghostnet + Tezos X previewnet, pointed at the remediated SDK head, completes green (matching the cell's last-known-good state).

## Assumptions

- The `wc-flow.spec.ts:17 "should load activeAccount on page reload"` failure is a pre-existing WalletConnect-relay flake unrelated to this branch's `peer.version` routing change. If reproduction on `master` confirms this, the remediation is to quarantine; if reproduction shows it is branch-specific, the remediation is to fix the v4 routing path on the wallet side. The remediation step MUST start by attempting reproduction on `master` before deciding.
- The lint suppressions blanket-banned by FR-018 do not include the existing pre-existing suppressions on lines this PR did not touch; the `lint:new` gate already scopes to touched lines, so this remediation is similarly scoped.
- Resolving Copilot comment C7 (duplicate version assertion) does not require changing the public contract of `getPeer()` — a private refactor (or a sibling `getPeerWithoutAsserting()` helper used internally) is acceptable.
- Comment C10 (accountId scheme mismatch) is locked to dApp-side materialisation only (see Clarifications, Session 2026-05-22). The v4 wire format and the wallet implementation are out of scope for this remediation; the companion PR `tezos-x-octez-connect#4` is unaffected.
- The branch protection rule on `trilitech/octez.connect` master requires `build-and-unit` and `end-to-end` to be green and does not require additional optional checks; merge is unblocked once both are green.
- No additional Copilot review pass will be triggered between the remediation commit landing and the human-maintainer merge. If a re-review fires and produces new comments, those are out of scope for this spec (a follow-up `/speckit-specify` would frame them).
- The remediation lands on the existing `feat/peer-version-handshake` branch (not a fresh stacked branch), as additional commits on top of `cf757e6`. The spec branch `004-fix-pr31-ci-and-review` in this companion repo (`trilitech/tezos-x-octez-connect`) holds the planning artifacts; the code change itself targets the upstream PR.
