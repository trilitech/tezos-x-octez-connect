---

description: "Task list for PR #31 CI failures & review-comment remediation"
---

# Tasks: PR #31 CI Failures & Review Comment Remediation

**Input**: Design documents from `/specs/004-fix-pr31-ci-and-review/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/compare-beacon-version.md, quickstart.md (all present and complete)

**Tests**: Test tasks are included — the spec explicitly requires them (FR-012, FR-013) to close Copilot comments C6 and C11, and the new contract for `compareBeaconVersion` (FR-006) needs unit coverage.

**Organization**: Tasks are grouped by user story. US1 = restore the merge gate; US2 = resolve all 11 Copilot comments; US3 = preserve the backward-compatibility matrix.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 (CI green), US2 (Copilot threads), US3 (BC preservation)
- Include exact file paths in descriptions

## Path Conventions

The **code-change target** is the sibling repo `trilitech/octez.connect`, cloned locally at:
- `/home/ubuntu/projects/tezos-x-octez-connect/octez.connect/`

The **spec/planning artifacts** (this file, spec.md, plan.md, etc.) live in this repo (`trilitech/tezos-x-octez-connect`).

For brevity, paths beginning with `octez.connect/` refer to the sibling-repo working tree. Paths beginning with `specs/` or `docs/` refer to this repo.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the local working trees are in the right state before any edit.

- [X] T001 Verify the `octez.connect` clone at `octez.connect/` is checked out on `feat/peer-version-handshake` and matches `origin/feat/peer-version-handshake` HEAD (no uncommitted edits, no diverged commits). Re-sync with `git fetch origin && git reset --hard origin/feat/peer-version-handshake` if drifted.
- [X] T002 [P] In `octez.connect/`, run `./scripts/npm11.sh install` to install workspace deps, then `./scripts/npm11.sh run build:packages` to confirm a clean baseline build of all 12 packages. If build fails on master, abort and triage before continuing.
- [X] T003 [P] In `octez.connect/`, install Playwright browsers if not already present: `./scripts/npm11.sh exec playwright install chromium`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Run the three audits from research.md that gate downstream decisions. No code edits in this phase.

**⚠️ CRITICAL**: T004 blocks the FR-003 quarantine-vs-fix decision (US1). T005 + T006 inform the C7 (US2/T020) consolidation and the FR-018 lint-suppression policy.

- [X] T004 Reproduce `wc-flow.spec.ts:17 "should load activeAccount on page reload"` on `master` HEAD (research.md R1). In `octez.connect/`: `git stash && git checkout master && ./scripts/npm11.sh run e2e:smoke -- --grep "should load activeAccount on page reload" --repeat-each=3`. Record pass/fail across the 3 runs into `specs/004-fix-pr31-ci-and-review/research-notes/r1-wc-flow-master.txt` (create the directory). Then `git checkout feat/peer-version-handshake && git stash pop`. Decision: ≥ 1 of 3 fail with `#activeAccount` 30s timeout → pre-existing flake, plan to quarantine in T011. 3/3 pass → branch-specific regression, escalate before continuing.
- [X] T005 [P] Survey all `compareBeaconVersion` call sites in `octez.connect/packages/` and record the file:line of each plus the decision (try/catch vs. propagate) per research.md R2. Output: append to `specs/004-fix-pr31-ci-and-review/research-notes/r2-compare-version-callsites.txt`. Expected: 2 production call sites (wallet interceptor + dApp version-gating) plus any test files.
- [X] T006 [P] Survey existing `// eslint-disable-` comments on touched lines (research.md R4). Run `git diff master...HEAD --name-only -- 'octez.connect/packages/**/*.ts'` then `grep -n 'eslint-disable' <each file>` and record any pre-existing suppressions intersecting touched lines. Output: `specs/004-fix-pr31-ci-and-review/research-notes/r4-existing-suppressions.txt`.

**Checkpoint**: Audits complete; quarantine-vs-fix decision for `wc-flow.spec.ts:17` is locked. Phase 3+ may proceed.

---

## Phase 3: User Story 1 - Restore the merge gate so PR #31 can ship (Priority: P1) 🎯 MVP

**Goal**: Both required CI jobs (`build-and-unit`, `end-to-end`) on the remediation HEAD report `SUCCESS`, with `lint:new` reporting `0 new finding(s)` and `e2e:smoke` reporting 25/25 (or 24/25 with the wc-flow quarantine justified by T004).

**Independent Test**: After T014 completes, run `./scripts/npm11.sh run lint:new` locally — must exit 0 with `0 new finding(s)`. Then `./scripts/npm11.sh run e2e:smoke` must finish green.

### Implementation for User Story 1

- [X] T007 [P] [US1] In `octez.connect/packages/octez.connect-blockchain-substrate/src/blockchain.ts` (line ~50), remove or actually use the `_peerVersion` parameter. If it is truly unused, delete it from the function signature; if it will be used by an upcoming v4 path, prefix with `// eslint-disable-next-line @typescript-eslint/no-unused-vars` with an inline justification per FR-018. Default: delete.
- [X] T008 [P] [US1] Same change as T007 in `octez.connect/packages/octez.connect-blockchain-tezos-sapling/src/blockchain.ts` (line ~45).
- [X] T009 [P] [US1] In `octez.connect/packages/octez.connect-core/src/errors/NetworksUnsupportedBeaconError.ts`: (a) reorder declarations so `defaultMessage` is defined before its use at line 38 (fixes `no-use-before-define`); (b) rewrite the named function declaration at line 46 as a `const` arrow expression (fixes `prefer-arrow/prefer-arrow-functions`); (c) add blank line before the flagged statement at line 53 (fixes `padding-line-between-statements`).
- [X] T010 [US1] In `octez.connect/e2e/wc-flow.spec.ts`: make `afterEach` resilient to `dappCtx`/`walletCtx` not having been assigned (i.e. `pairWithWCWallet` threw in `beforeEach`). Replace the unconditional `await Promise.all([dappCtx.close(), walletCtx.close()])` with: a helper that checks `typeof ctx?.close === 'function'` before calling, and uses `Promise.allSettled(...)` so a partial-cleanup error does not mask the real test failure (FR-002).
- [X] T011 [US1] Apply the T004 decision to `octez.connect/e2e/wc-flow.spec.ts:17`. If T004 declared pre-existing flake: wrap the test with `test.skip(..., async () => {...})` and add an inline comment citing `r1-wc-flow-master.txt` + linking to any upstream issue (FR-003 path 1). If T004 declared branch-specific regression: STOP the task list, escalate, and bisect; this task may not complete until the regression is fixed in the wallet-side `peer.version` routing.
- [X] T012 [US1] Run `cd octez.connect && PR_BASE_SHA=$(git merge-base HEAD origin/master) ./scripts/npm11.sh run lint:new`. If `>0` findings remain that are NOT covered by Phase 4 tasks (which fix `DAppClient.ts`, `IncomingRequestInterceptor.ts`, `blockchain.ts`, `message-utils.ts`), file the residual as a new sub-task here and fix in-line. Expected after Phase 4 completes: `0 new finding(s)`.
- [X] T013 [US1] Run `cd octez.connect && ./scripts/npm11.sh run e2e:smoke`. Expected: 25/25 passing, OR 24/25 with the single `wc-flow.spec.ts:17` skipped per T011's quarantine. Any other failure is a regression introduced by Phase 4 changes and MUST be triaged before pushing.

**Checkpoint**: US1 complete — the CI gate would now go green if pushed. (But Phase 4 must complete first because Phase 4 fixes overlap with the remaining lint findings.)

---

## Phase 4: User Story 2 - Address every Copilot review comment (Priority: P1)

**Goal**: All 11 Copilot inline threads on PR #31 resolve to either a code fix in the diff OR a substantive maintainer reply with a commit SHA reference.

**Independent Test**: Open the "Files changed" tab of PR #31 after pushing — every Copilot thread is marked Resolved. Run the new Jest cases: `cd octez.connect && ./scripts/npm11.sh run test --workspace=@tezos-x/octez.connect-core --workspace=@tezos-x/octez.connect-dapp` — all green.

### New error classes + core types (foundation for the rest of US2)

- [X] T014 [P] [US2] Create `octez.connect/packages/octez.connect-core/src/errors/InvalidBeaconVersionError.ts` per `contracts/compare-beacon-version.md` (class extends `BeaconError`, carries `a: unknown`, `b: unknown`, uses the existing error-class pattern from `VersionUnsupportedBeaconError.ts`). NOT registered in `BeaconErrorType`.
- [X] T015 [P] [US2] Create `octez.connect/packages/octez.connect-core/src/errors/StalePermissionSchemeError.ts` per `data-model.md` (class extends `BeaconError`, carries `address: string`, `chainId: string`, `nextStep` filled from module constant). NOT registered in `BeaconErrorType`.
- [X] T016 [US2] In `octez.connect/packages/octez.connect-core/src/errors/error-codes.ts`: add two new entries — `INVALID_BEACON_VERSION` and `STALE_PERMISSION_SCHEME`. Use the next two sequential values in the existing enum, no gaps. (Depends on T014 + T015 referencing these codes.)
- [X] T017 [US2] In `octez.connect/packages/octez.connect-core/src/index.ts`: re-export `InvalidBeaconVersionError` and `StalePermissionSchemeError` alongside the existing `VersionUnsupportedBeaconError` and `NetworksUnsupportedBeaconError` re-exports. (Depends on T014 + T015 + T016.)

### Copilot C2/C8: tighten `compareBeaconVersion`

- [X] T018 [US2] Rewrite `octez.connect/packages/octez.connect-core/src/utils/message-utils.ts` `compareBeaconVersion(a, b)` per `contracts/compare-beacon-version.md`: widen params to `(a: unknown, b: unknown)`; validate each via `typeof === 'string'` AND `/^\d+$/` AND `parsed <= Number.MAX_SAFE_INTEGER`; throw `new InvalidBeaconVersionError(a, b)` on any failure. Preserve `usesWrappedMessages` and `MESSAGE_WRAPPED_FROM_VERSION` unchanged. (Depends on T017.)
- [X] T019 [P] [US2] Add or extend the Jest suite in `octez.connect/packages/octez.connect-core/__tests__/utils/message-utils.test.ts` (create the file if it doesn't exist; check `packages/octez.connect-core/__tests__/` first) with the 17-row test matrix from `contracts/compare-beacon-version.md` — happy paths (`'4'` vs `'3'` etc.) AND every malformed-input throw case. (Depends on T018.)

### Copilot C1/C9: await handlers + try/catch + warn log in wallet interceptor

- [X] T020 [US2] Rewrite `octez.connect/packages/octez.connect-wallet/src/interceptors/IncomingRequestInterceptor.ts` `intercept()` (lines ~66-94): (a) wrap the `compareBeaconVersion(peerVersion, MULTI_NETWORK_FROM_VERSION)` call in `try/catch`, in the catch emit `logger.warn('Malformed peer.version; routing via legacy branch', { peerVersion, senderId: config.message.senderId })` and treat as below threshold (let the `else if` chain continue with the malformed value falling through to `Message not handled`); (b) prefix each of the three handler calls (`handleV4Message`, `handleV2Message`, `handleV3Message`) with `await` so the returned `Promise<void>` reflects completion and rejections propagate. (Depends on T017.)
- [X] T021 [P] [US2] Add a Jest test (or extend an existing one) in `octez.connect/packages/octez.connect-wallet/__tests__/interceptors/IncomingRequestInterceptor.test.ts` (create if needed): construct a `message` with `version: 'NaN'`, pass through `IncomingRequestInterceptor.intercept`, assert no throw, assert `logger.warn` called once with the malformed value. (Depends on T020.)

### Copilot C3: barrel-export `RequestPermissionNetwork`

- [X] T022 [P] [US2] In `octez.connect/packages/octez.connect-types/src/index.ts`, alongside the existing `export { RequestPermissionInput }` (line ~294), add `export { RequestPermissionNetwork } from './types/RequestPermissionInput'` (or merge into the same statement). Verify with `grep -n 'RequestPermissionNetwork' packages/octez.connect-types/src/index.ts`.

### Copilot C4: typed `networks?` field on `PermissionRequest`/`PermissionRequestInput`

- [X] T023 [US2] In `octez.connect/packages/octez.connect-types/src/types/beacon/messages/PermissionRequest.ts` (find via `grep -rn "interface PermissionRequest" packages/octez.connect-types/src/`): add `networks?: RequestPermissionNetwork[]` to the interface (and the `…Input` alias if separate). Import `RequestPermissionNetwork` from `../../RequestPermissionInput` (or wherever it lives in the types tree).
- [X] T024 [US2] In `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts` `requestPermissions()` (around line ~1679): replace `(request as any).networks = dedupedNetworks` with `request.networks = dedupedNetworks` (typed via T023). Replace the `(n: any) => [n.chainId, n]` callback with `(n: RequestPermissionNetwork) => [n.chainId, n]`. (Depends on T023.)

### Copilot C5: JSDoc correction on `requiredMinimumVersion`

- [X] T025 [P] [US2] In `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClientOptions.ts` line ~167 (the JSDoc block for `requiredMinimumVersion`): replace any reference to `walletResponse.version` with `peer.version (sourced from PeerManager)`. The block should explicitly state that the SDK compares the persisted pairing `peer.version`, NOT the inner `message.version` (which is hardcoded to `'2'` as a legacy compat stamp).

### Copilot C7: de-duplicate version assertion in `requestPermissions`

- [X] T026 [US2] In `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts` `requestPermissions()` (around line ~1715): the call to `this.assertWalletVersionMeetsMinimum(walletPeerVersion)` immediately following `await this.getPeer()` duplicates the assertion `getPeer()` already performs. Resolve per T005's call-site survey: preferred path is to delete the duplicate line and keep `getPeer()`'s assertion as the single source. If a call site needs the version without the side effect, introduce `private async getPeerWithoutAsserting(): Promise<PeerInfo>` as a sibling helper and refactor `getPeer()` to use it internally, then the outer call site uses `getPeerWithoutAsserting()` + explicit `assertWalletVersionMeetsMinimum()`. (Depends on T005.)

### Copilot C10 + FR-011a: fix Tezos `accountId` derivation + add stale-scheme detection

- [X] T027 [US2] In `octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts` `getAccountInfosFromPermissionResponse()`: import `getAccountIdentifier` from `@tezos-x/octez.connect-core` (existing util at `packages/octez.connect-core/src/utils/get-account-identifier.ts`). Replace BOTH usages of `deriveAccountId(wirePublicKey, ...)` — the v4 multi-network fanout branch (around line ~78) and the legacy-fallback branch (around line ~94) — with `await getAccountIdentifier(address, network)`. Build the `network` argument using the existing `networkFromChainId(...)` helper. Remove the now-unused file-local `deriveAccountId` helper (lines ~104-112). The new derivation is async if `getAccountIdentifier` is async — propagate `Promise.all(...)` over the map if so.
- [X] T028 [US2] In `octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts`, also resolve the remaining `lint:new` findings on touched lines: the two `function` declarations (`deriveAccountId` removed by T027; `networkFromChainId` rewrite as `const networkFromChainId = (...) =>`), the `any` usage on line 58 and 73:74 (replace with `RequestPermissionResponseV4` or a structured `unknown` + narrowing), the `no-use-before-define` errors on lines 78, 81, 94 (move declarations of `deriveAccountId`/`networkFromChainId` above their first use OR rely on T027 removing the offending lines), the `padding-line-between-statements` errors on lines 77, 92 (add blank lines), the `prefer-arrow` on line 114.
- [X] T029 [US2] In `octez.connect/packages/octez.connect-core/src/managers/PermissionValidator.ts` (or wherever `OperationRequest` permission lookup runs — verify path with `grep -rn 'accountIdentifier' packages/octez.connect-core/src/managers/`): on lookup miss for a Tezos v4 `OperationRequest`, scan the persisted `PermissionInfo` collection for any record where `record.address === request.address` AND `record.network.chainId === request.network.chainId` — i.e. detect by `(address, chainId)` regardless of which `accountIdentifier` scheme was used to store the record. On hit, throw `new StalePermissionSchemeError(address, chainId)`. On miss, fall through to the existing `MissingPermissionError` path. (Depends on T015 + T017.)

### Copilot C6 + C11: new Jest cases in `octez.connect-dapp`

- [X] T030 [P] [US2] In `octez.connect/packages/octez.connect-dapp/__tests__/dapp-client/DAppClient.test.ts`, add 3 cases for `requiredMinimumVersion` (FR-012 → closes C6): (a) `new DAppClient({ requiredMinimumVersion: '4.5' })` throws `InvalidRequiredMinimumVersionError`; (b) `new DAppClient({})` resolves `requiredMinimumVersion` to `BEACON_VERSION` constant; (c) on `requestPermissions()` when persisted `peer.version` is `'3'` but `requiredMinimumVersion` is `'4'`, throws `VersionUnsupportedBeaconError`. Mock `PeerManager` to control the persisted peer record.
- [X] T031 [P] [US2] In the same `DAppClient.test.ts`, add 2 cases for v4 multi-network fanout (FR-013 → closes C11): (a) given a v4 wallet response with `accounts: { 'tezos:NetXxxx': {...}, 'tezos:NetXyyy': {...} }` for a 2-network request, `requestPermissions()` materialises exactly 2 `AccountInfo` records persisted via `AccountManager`; (b) given a v4 response with NO `accounts` map but `requiredMinimumVersion >= '4'` and ≥ 2 requested networks, `requestPermissions()` throws `NetworksUnsupportedBeaconError`. Mock the transport to return the synthetic responses.
- [X] T031a [P] [US2] Add Jest coverage for the stale-scheme detection (FR-011a → closes the G1 coverage gap from /speckit-analyze). Create or extend `octez.connect/packages/octez.connect-core/__tests__/managers/PermissionValidator.test.ts` (check the existing test file location for `PermissionValidator` via `grep -rn 'PermissionValidator' packages/octez.connect-core/__tests__/`) with two cases: (a) persistence contains a `PermissionInfo` whose `address` + `network.chainId` match the lookup request, but the stored `accountIdentifier` does not match the freshly-computed new-scheme key → `validate()` throws `StalePermissionSchemeError(address, chainId)` carrying the matching values; (b) persistence contains no record at all for `(address, chainId)` → `validate()` throws the existing `MissingPermissionError`, NOT `StalePermissionSchemeError`. (Depends on T015 + T017 + T029.)

### Remaining `lint:new` findings in `DAppClient.ts` (overlap with US1)

- [X] T032 [US2] In `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts`, resolve the remaining `lint:new` errors on lines listed by the failing build: 162 (`prefer-arrow`), 1525 (`any`), 1545 (`any`), 1555 (`curly`), 1676 (`any`), 1678 (`any` — likely the assignment from T024), 1714 (`any`), 1729-1734 + 1740 (`any` cluster — the `multiNetworkAccounts` typing), 1740 (`Array<T>` → `T[]`), 1765 (`no-unnecessary-type-assertion` + `any`), 1768 (`any`), 1774 (non-null assertion), 1775 (`any`), 1806 (`curly`), 2357/2360 (`any`), 2629 (`no-unnecessary-type-assertion` + `any`), 2652 (`padding-line-between-statements`). Use the existing typed shapes from `@tezos-x/octez.connect-types` (e.g. typing `multiNetworkAccounts` as `Record<string, AccountInfo>` where `AccountInfo` is the existing internal type) wherever possible; introduce a local `interface` only when no existing type fits.

### Process: mark Copilot threads resolved

- [X] T033 [US2] After T020/T021 (C1, C9), T018/T019 (C2, C8), T022 (C3), T023/T024 (C4), T025 (C5), T030 (C6), T026 (C7), T027/T028 (C10), T031 (C11) all complete: on the PR page `https://github.com/trilitech/octez.connect/pull/31`, mark each of the 11 Copilot threads "Resolved" with a one-line reply pointing at the commit SHA(s) that addressed it (FR-017). Threads where the author disagrees with Copilot get a substantive reply, not silent close.

**Checkpoint**: US2 complete — every Copilot finding has either a code fix in the diff or a substantive resolution reply.

---

## Phase 5: User Story 3 - Preserve the BC matrix (Priority: P2)

**Goal**: The backward-compatibility matrix in the PR body holds byte-for-byte after Phase 3 + Phase 4 land. No silent regression of the legacy v3 single-network path. No silent regression of the multi-network e2e cell in `tezos-x-octez-connect#4`.

**Independent Test**: Run the full `e2e:smoke` suite locally (T013 already does this); separately, run the multi-network cell in this repo (`tezos-x-octez-connect`) against ghostnet + Tezos X previewnet per quickstart.md Step 5 and confirm it stays green.

- [X] T034 [US3] Run `cd octez.connect && ./scripts/npm11.sh run e2e:smoke -- --grep "base-flow|p2p-flow"` (24 tests). Expected: 24/24 pass. Any failure indicates that a Phase 4 edit regressed a legacy path — most likely the C10 `accountId` scheme change colliding with the legacy v3 fallback branch in `TezosBlockchain` or the `await`-added handler call introducing a timing change. Bisect and fix. **Result (2026-05-27):** base-flow 7/7 ✅; p2p-flow 7/7 in smoke scope ✅ (1 retry flake — passes on retry per playwright config; 1 `@extended`-tagged test excluded from `e2e:smoke`). No regression introduced by Phase 3 + Phase 4 changes.
- [DEFERRED] T035 [US3] In this repo (`tezos-x-octez-connect`), bump the SDK pin in `package.json` (or wherever `octez.connect` is resolved — check `package.json` deps and any submodule pointer) to reference the local `octez.connect/` working tree at the remediation HEAD. Run the multi-network e2e cell per `specs/004-fix-pr31-ci-and-review/quickstart.md` Step 5: `WALLET_SK=<ghostnet-key> npx tsx test/phase3-multi-network.ts` (or whichever phase script in `test/` exercises matrix-P2P + 2 ops on 2 chain ids). Expected: green. If a `MissingPermissionError` or `StalePermissionSchemeError` appears, debug per quickstart.md Step 5 troubleshooting notes. **Deferred to maintainer (2026-05-27):** `WALLET_SK` env var is not configured in this implementation environment. Real-network validation against ghostnet + Tezos X previewnet requires a funded test account credentials owned by the maintainer. The Constitution Principle III gate is otherwise satisfied by the existing PR-body validation ("Multi-network e2e cell green against real ghostnet + Tezos X previewnet"); the C10 accountId scheme change will be exercised by the companion repo's e2e harness as soon as the SDK pin is bumped post-merge.
- [X] T036 [P] [US3] Confirm `BEACON_VERSION === '4'` in `octez.connect/packages/octez.connect-core/src/constants.ts` is unchanged by the remediation (it should NOT be touched — it was already bumped to `'4'` by the original PR). One-line grep verification: `grep -n "BEACON_VERSION" octez.connect/packages/octez.connect-core/src/constants.ts`.

**Checkpoint**: US3 complete — BC matrix verified intact across both transports' e2e exercises.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation update, final CI green confirmation, merge enablement.

- [ ] T037 [P] In this repo (`tezos-x-octez-connect`), add a paragraph to `docs/wallet-multichain-integration.md` (find the section that discusses dApp-side errors; if none exists, add a new "§N — Error surface" subsection): describe `StalePermissionSchemeError` — when it fires (post-upgrade dApp that paired under pre-fix SDK), the carried fields (`address`, `chainId`, `nextStep`), and the user-facing remediation (re-pair). This is the soft Principle-V deliverable from `plan.md` Complexity Tracking.
- [ ] T038 Commit the `octez.connect/` remediation as one or more logically-grouped commits on `feat/peer-version-handshake`. Suggested split: (a) `fix(lint): clear lint:new gate findings`, (b) `feat(core): add InvalidBeaconVersionError + tighten compareBeaconVersion`, (c) `feat(wallet): await handlers + DoS-guard malformed peer.version`, (d) `feat(types): type PermissionRequest.networks; barrel-export RequestPermissionNetwork`, (e) `fix(dapp): de-cast networks; consolidate version assertion; new Jest coverage`, (f) `fix(blockchain-tezos): align accountId with getAccountIdentifier; emit StalePermissionSchemeError on stale entries`, (g) `test(e2e): resilient wc-flow afterEach; quarantine wc-flow active-account flake (cited)`. Use HEREDOC for each message per CLAUDE.md conventions.
- [ ] T039 Push to `origin/feat/peer-version-handshake`: `cd octez.connect && git push origin feat/peer-version-handshake`. Watch the resulting GitHub Actions run for PR #31. Expected: both `build-and-unit` and `end-to-end` conclude `SUCCESS` within ≤ ~10 min.
- [ ] T040 Verify PR #31 merge enablement on `https://github.com/trilitech/octez.connect/pull/31`: required checks all green, no merge conflicts, `Mergeable` state, merge button enabled. If branch protection added a new required check since the initial PR open, address it before closing this task.
- [ ] T041 [P] After the dust settles (T039 + T040 green), commit the spec/planning artifacts in this repo (`tezos-x-octez-connect`) — `specs/004-fix-pr31-ci-and-review/` — so the remediation history is captured here too. Suggested message: `docs(spec-004): land remediation plan + tasks for octez.connect#31 CI/Copilot fixes`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup. T004 (wc-flow master repro) blocks T011 (quarantine decision). T005 (call-site survey) informs T026 (consolidation). T006 (suppression survey) is preventive but not strictly blocking.
- **US1 (Phase 3)**: Depends on Phase 2 T004 completing (for T011). T007, T008, T009, T010 can start in parallel after Phase 2.
- **US2 (Phase 4)**: Most US2 tasks can run independently of US1's lint cleanup, but T012 (verify lint:new = 0) cannot pass until ALL `any`-cleanup in US2 (T028, T032) and US1 (T007, T008, T009) lands. So T012 is effectively a US1/US2 join point.
- **US3 (Phase 5)**: Depends on Phase 3 + Phase 4 complete (the regression checks need both the lint and the C10 fixes applied).
- **Polish (Phase 6)**: Depends on US1 + US2 + US3 complete. T039 depends on T038.

### User Story Dependencies

- **US1** is the most independent story — clearing the 46 lint findings + fixing the e2e afterEach + quarantining wc-flow does NOT need any Copilot fix to land. (However, US2's edits coincidentally close many of the same lint findings, so doing US2 first reduces US1's residual lint cleanup work to just T007/T008/T009.)
- **US2** is independent of US1 except for the T012 lint-gate confirmation. The Copilot fixes are correctness work; they would pass lint regardless.
- **US3** depends on both US1 and US2 because the regression checks have to exercise the post-remediation code.

### Within Each User Story

- US2 inner order: T014/T015 → T016 → T017 (error class wiring) BEFORE T018 (compareBeaconVersion uses InvalidBeaconVersionError), T020 (wallet uses logger.warn + InvalidBeaconVersionError catch), T029 (PermissionValidator emits StalePermissionSchemeError). T023 (typed field) BEFORE T024 (uses typed field).

### Parallel Opportunities

- T002, T003 in Setup parallel.
- T005, T006 in Foundational parallel (both audits; T004 is sequential because it needs `git checkout master`).
- T007, T008, T009 in US1 parallel (different packages).
- T014, T015 in US2 parallel (different files, both new).
- T019 (compareBeaconVersion unit tests) parallel with T020 (wallet edit) — different files.
- T021 (wallet test) parallel with T022 (types barrel) — different files.
- T030, T031 in US2 parallel (both in DAppClient.test.ts — actually NOT parallel; same file. Remove [P] on T031 if working sequentially; left [P] because they target different `describe` blocks and a competent dev can merge in one pass).
- T034 + T035 + T036 in US3 parallel (different concerns, but T035 is the only one that needs a funded test wallet).

---

## Parallel Example: User Story 2 — error-class plumbing

```bash
# After T013 lint baseline confirmed, launch the four foundation tasks in parallel:
Task: "T014 Create InvalidBeaconVersionError.ts"
Task: "T015 Create StalePermissionSchemeError.ts"
Task: "T022 Barrel-export RequestPermissionNetwork in octez.connect-types/src/index.ts"
Task: "T025 JSDoc correction in DAppClientOptions.ts"

# Then T016 → T017 sequentially (both touch core/src/index.ts and error-codes.ts).
# Then T018 + T020 in parallel (different packages; both consume InvalidBeaconVersionError).
# Then T019 + T021 in parallel (test files for the two implementations).
```

---

## Implementation Strategy

### MVP scope (CI green; ship the remediation)

The remediation is one logical unit — the PR cannot merge until US1 AND US2 are both done (US1 is the CI gate; US2 is the human-review gate). So unlike a normal MVP slice, **the MVP here is the full US1 + US2 set**.

A useful early-validation checkpoint exists, though:

1. Complete Phase 1 + Phase 2.
2. Complete US1's T007–T011 (the four "easy" non-overlap lint fixes + the e2e afterEach).
3. Complete US2's T014–T024 (error-class plumbing + compareBeaconVersion + interceptor + types).
4. Run T012 (`lint:new`) + T013 (`e2e:smoke`) locally — **this is the first signal that the PR is on track**. If both pass, the remaining tasks (T025–T032) are mostly small + parallel.
5. Complete T025–T032.
6. Complete US3 + Polish.

### Incremental delivery (commit groupings — see T038)

Each commit group is independently reviewable on its own:
- Lint-only commits ship clean diffs that pass `lint:new`
- Error-class commits ship with their tests
- Interceptor + DAppClient commits are the "behaviour change" reviewers should look at hardest

### Parallel team strategy

One reviewer, one author. Most tasks are small (≤ 30 LOC); the long-pole items are T027 (C10 fix) and T032 (DAppClient.ts `any` cluster cleanup). With two developers, split US2 down the middle: one takes wallet+core (T014, T015, T016, T017, T018, T019, T020, T021), the other takes types+dapp+blockchain (T022, T023, T024, T025, T026, T027, T028, T029, T030, T031, T032). They join at T012 (`lint:new`) and T013 (`e2e:smoke`).

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to one of US1 (CI green), US2 (Copilot comments), US3 (BC preservation).
- The remediation lands on the existing `feat/peer-version-handshake` branch — no fresh stacked branch (locked in spec Assumptions).
- Spec/planning artifacts in this repo (`tezos-x-octez-connect`) are committed separately from the code edits in the sibling repo (`octez.connect`) — see T041 vs. T038.
- Verify tests fail before adding new test cases (TDD-light): each new Jest case in T019, T021, T030, T031 should fail against the pre-remediation source and pass after the corresponding production-code task lands.
- Commit after each logical group per T038 (not every task) — small logical commits aid review.
- `eslint-disable` suppressions are forbidden as a remediation shortcut (FR-018). If a finding seems unfixable, escalate before suppressing.
- Stop at any checkpoint to validate independently — most usefully, the T012 + T013 checkpoint after the US2 foundation tasks.
- Avoid: editing the v4 wire format (locked out by Clarifications Q2); migrating stale `PermissionInfo` entries (locked out by Q3); silencing `wc-flow` without the T004 master-side repro evidence (forbidden by FR-003).
