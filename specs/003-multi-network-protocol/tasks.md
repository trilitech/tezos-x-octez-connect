---
description: "Task list for 003-multi-network-protocol"
---

# Tasks: Multi-Network Protocol Support for Beacon v4

**Input**: Design documents from `/specs/003-multi-network-protocol/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included as **mandatory** (not optional) because constitution Principle II (NON-NEGOTIABLE) requires end-to-end validation per transport for any protocol-surface change.

**Organization**: Tasks are grouped by user story (US1 = multi-network session, US2 = requestOperation({network}), US3 = reference apps demonstrate clean API). Setup and Foundational phases are pre-story. Bucket A (SDK PR — incremental commits on the open `feat/peer-version-handshake` PR) is interleaved with Bucket B (outer-repo PR off `003-multi-network-protocol`). Polish + constitution attestation + PR finalization close out.

## Repository topology (read this first)

Same cross-repo topology as spec 002:

1. **`tezos-x-octez-connect/`** — the outer repo (branch `003-multi-network-protocol`). Spec/plan/tasks/contracts, the reference apps under `wc2/`, `dapp/`, `wallet/`, the e2e harness under `test/`, and the public-facing website + docs.
2. **`octez.connect/`** — a standalone clone of `github.com/trilitech/octez.connect` (currently on `feat/peer-version-handshake @ 82b6094b`, gitignored from the outer repo). **The SDK delta for spec 003 ships as incremental commits on this same branch** — no new demo branch (per spec Clarifications Session 2026-05-20, Decision: Delivery shape).

SDK edits (paths starting `octez.connect/packages/...`) MUST happen on the existing `feat/peer-version-handshake` branch inside the clone. All other edits (paths NOT starting `octez.connect/`) happen on the outer repo's `003-multi-network-protocol` branch.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Different file, no dependency on incomplete tasks — safe to parallelize.
- **[US1]/[US2]/[US3]**: Maps task to the user story it satisfies.
- File paths are absolute or repository-relative as appropriate.

---

## Phase 1: Setup

**Purpose**: Confirm spec 002 baseline; capture pre-change baselines.

- [X] T001 Confirmed `git -C octez.connect rev-parse --abbrev-ref HEAD` shows `feat/peer-version-handshake` and `HEAD` is `82b6094b`. Clean working tree. The open spec 002 PR in `trilitech/octez.connect` is the target for incremental commits.
- [X] T002 [P] Captured pre-change grep baselines in `specs/003-multi-network-protocol/grep-baseline.txt`. Findings: `(client as any).makeRequest` = 6 lines (3 per dApp — save+override+restore), `partialAccountInfos[0]` = 4 lines in DAppClient.ts (1523, 1529, 1530, 1551), `accountId: ''` = 1 line in TezosBlockchain stub (line 57), inline chain-id branching = 5 lines across both reference wallets. After-counts in T029.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Ship the new error class consumed by every user story. All work on the `feat/peer-version-handshake` branch in the SDK clone. **No user-story work may begin until Phase 2 completes.**

- [X] T003 Created `octez.connect/packages/octez.connect-core/src/errors/NetworksUnsupportedBeaconError.ts` per [contracts/networks-unsupported-error.md](./contracts/networks-unsupported-error.md). Template: spec 002's `VersionUnsupportedBeaconError.ts`. Carries `errorCode: 'NETWORKS_UNSUPPORTED'`, `requestedNetworks: string[]`, `unsupportedNetworks: string[]`. Pass `BeaconErrorType.UNKNOWN_ERROR` as the sentinel (class is never wire-serialized). **Naming caveat (analysis finding T1)**: the existing `NetworkNotSupportedBeaconError.ts` (singular, wire-registered, spec 002 baseline) is unchanged and is a different class. This new class is plural and client-side-only. Reviewers should expect to see both filenames coexist.
- [X] T004 Re-exported `NetworksUnsupportedBeaconError` from `octez.connect/packages/octez.connect-core/src/index.ts` alongside the spec 002 errors. Added `NETWORKS_UNSUPPORTED: 'NETWORKS_UNSUPPORTED'` to `BEACON_ERROR_CODES` in `error-codes.ts`.

**Checkpoint**: Foundation ready. User stories can now begin.

---

## Phase 3: User Story 1 — Multi-network session from a single permission request (Priority: P1) 🎯 MVP

**Story Goal**: A dApp calls `client.requestPermissions({ networks: [L1, L2] })` and the SDK persists every account the wallet returned — accessible via existing `getAccounts()` / `setActiveAccount()`. Today's `partialAccountInfos[0]` slice is gone; the `TezosBlockchain` stub is replaced with a real parser; the FR-019 defensive check guards against older v4 wallets missing the `accounts[]` fanout.

**Independent Test**: After `requestPermissions({ networks: [L1, L2] })` resolves, `await client.getAccounts()` returns ≥ 2 records with distinct `network.chainId` values. Filter `accounts.find(a => a.network.chainId === 'tezos:NetXY2oPPzkxUW1')` returns a populated record. Verified against ghostnet (L1) + Tezos X previewnet (L2) on the matrix-P2P transport.

### Implementation for US1 (Bucket A — SDK)

- [X] T005 [US1] Replaced the stub `TezosBlockchain.getAccountInfosFromPermissionResponse()` in `octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts`. Real parser handles both v4 multi-network (`blockchainData.accounts` CAIP-2-keyed map → N records, deriving distinct `accountId` from `(publicKey, chainId)`) and v3 legacy single-network fallback. Widened `Network` interface in `octez.connect-types` to include optional `chainId?: string` so the spec 003 contract `a.network.chainId === target` filter works. in `octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts:47-63` with a real parser. Read `permissionResponse.blockchainData.accounts` (CAIP-2-keyed map on v4) and return one record per entry: `{ accountId, address, publicKey, network: { type: 'custom', chainId, rpcUrl }, scopes }`. For v3 single-network responses (no `accounts` map), fall back to the single-record shape. Mirror the working Sapling parser at `octez.connect/packages/octez.connect-blockchain-tezos-sapling/src/blockchain.ts:43-58`. Derive `accountId` from `(publicKey, chainId)` deterministically. See [research.md](./research.md) R2 Path A.
- [X] T006 [US1] Removed the `partialAccountInfos[0]` slice in `DAppClient.permissionRequest` (v3 typed path) — replaced with a `.map(...)` + `for` loop. Added a parallel multi-network branch in `DAppClient.requestPermissions` (legacy path) that detects `message.accounts` (CAIP-2-keyed map) and builds N `AccountInfo`s via the same primitives `onNewAccount` uses (`prefixPublicKey`, `getAddressFromPublicKey`, `getAccountIdentifier`). Added dedupe at the upstream emit site (line ~1652) — `new Map(input.networks.map(n => [n.chainId, n])).values()` — satisfying the spec edge case. in `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts:1518-1551`. Replace the single-record `accountInfo` block with a `for (const p of partialAccountInfos)` loop creating one `AccountInfo` per entry and calling `accountManager.addAccount(...)` for each. Set the first entry as the active account via `setActiveAccount`. Apply the same N→loop pattern to the `notifySuccess` call site (lines 1548–1558); the `output` payload for the first record matches today's behavior. See [contracts/multi-network-permission.md](./contracts/multi-network-permission.md) C6. **Additionally (analysis finding C3)**: at the upstream emit-site around `DAppClient.ts:1648-1654` (the spec 002 `(request as any).networks = input.networks` stamp), dedupe `input.networks` by `chainId` before stamping — `const uniqueNetworks = Array.from(new Map(input.networks.map(n => [n.chainId, n])).values())`. This satisfies the spec edge case "DApp lists the same network twice in `networks[]` → SDK MUST dedupe before dispatching".
- [X] T007 [US1] FR-019 defensive check added in `DAppClient.requestPermissions` immediately before the multi-network loop, gated on the full four-condition rule from research R6: `Number(walletPeerVersion) >= 4` AND `request.networks.length >= 2` AND `Number(this.requiredMinimumVersion) >= 4` AND missing chain ids non-empty → throws `NetworksUnsupportedBeaconError` with `requestedNetworks` + `unsupportedNetworks` populated. immediately after the loop in T006. Compute `requestedNetworks = request.networks?.map(n => n.chainId) ?? []`, `servedChainIds = accountInfos.map(a => a.network?.chainId).filter(Boolean)`. **Four-condition gate (analysis finding A1, per [research.md](./research.md) R6)**: only raise if (1) `peer.version >= '4'` AND (2) `requestedNetworks.length >= 2` AND (3) `missing = requestedNetworks.filter(c => !servedChainIds.includes(c))` is non-empty AND (4) `this.requiredMinimumVersion >= '4'` (the dApp did NOT explicitly relax to v3 via the spec 002 SDK option — otherwise the dApp accepted v3-style single-network behavior on purpose). When all four hold, throw `new NetworksUnsupportedBeaconError({ requestedNetworks, unsupportedNetworks: missing })`. See [contracts/networks-unsupported-error.md](./contracts/networks-unsupported-error.md) F4.

### SDK integration test for US1 (Bucket A — SDK)

- [ ] T008 [US1] Add a unit/integration test in `octez.connect/packages/octez.connect-dapp/test/` (or the existing test directory pattern) that exercises: (a) two-record permission response → 2 `AccountInfo`s persisted with distinct chain ids (C6); (b) single-record response → 1 `AccountInfo` persisted (C9 backward compat); (c) v4 multi-network request with response missing one chain id → `NetworksUnsupportedBeaconError` thrown with correct `unsupportedNetworks`. Use mock wallet responses crafted to match the contract; this is the SDK's own test surface, not the cross-repo e2e (T016–T020).

**Checkpoint**: dApp SDK exposes N `AccountInfo`s per multi-network session. **US1 is independently shippable as MVP** for the SDK PR (Bucket A) once T005–T008 land.

---

## Phase 4: User Story 2 — Send an operation to a specific network without monkey-patching (Priority: P1)

**Story Goal**: `client.requestOperation({ network: '<CAIP-2>', operationDetails: [...] })` works end-to-end. Outgoing wire message carries the CAIP-2 string in `network`. Validation rejects unauthorized or missing network arguments before the wire send. Reference dApp monkey-patches removed (US3 covers that).

**Independent Test**: A dApp on a multi-network session calls `client.requestOperation({ network: '<L2 chainId>', operationDetails: [...] })`. The wallet receives the wire message carrying that CAIP-2 string, signs and broadcasts on the L2 RPC, dApp resolves with the L2 confirmation hash. Same flow works for L1 in the same session. Calling without `network` on a multi-network session rejects with `NetworksUnsupportedBeaconError` (no wire send). Calling with an unauthorized `network` rejects (no wire send).

### Implementation for US2 (Bucket A — SDK)

- [X] T009 [P] [US2] Added `network?: string` to `octez.connect/packages/octez.connect-types/src/types/RequestOperationInput.ts` with full JSDoc covering O2 (CAIP-2 format), O3 (session-membership check), O4 (ambiguous default rejection), O5 (single-network fallback). File grew from 8 to ~28 lines including JSDoc. with full JSDoc per [contracts/operation-request-network.md](./contracts/operation-request-network.md). Type is currently 8 lines total; after change is ~13 lines including JSDoc.
- [X] T010 [P] [US2] Widened `OperationRequest.network` from `Network` to `Network | string` in `octez.connect/packages/octez.connect-types/src/types/beacon/messages/OperationRequest.ts`. `OperationRequestInput` (defined as `Optional<OperationRequest, ...>` in `BeaconRequestInputMessage.ts`) inherits the widened type automatically. Two downstream consumers needed string-handling shims (`PermissionValidator.ts:33` and `DAppClient.ts:2334` — convert string → minimal Network for `getAccountIdentifier`). in `octez.connect/packages/octez.connect-types/src/types/`. Find the type with `grep -rn "interface OperationRequestInput" octez.connect/packages/octez.connect-types/src/`. The widening is byte-for-byte backward compatible — wallet handler at `wallet/src/index.ts:319-333` already discriminates on `typeof`. See [research.md](./research.md) R4.
- [X] T011 [US2] Plumbed `input.network` through `DAppClient.requestOperation`. New `private async resolveOperationNetwork(inputNetwork, activeAccount)` helper enforces: (A2) CAIP-2 format check via `/^tezos:[A-Za-z0-9]+$/` regex before anything else; (O3) session-membership check against `accountManager.getAccounts().map(a => (a.network as any)?.chainId)`; (O4) ambiguous-multi-network rejection when input omitted and >1 chain id in session; (O5) legacy fallback to `activeAccount.network || this.network` for single-network sessions. Helper is called from `requestOperation` before building the outgoing `OperationRequestInput`. in `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts:1985-2027`. Before building the request, resolve the target chain id with FR-009/FR-010/FR-011 rules: **first validate CAIP-2 format (analysis finding A2)** — `input.network` MUST match `/^tezos:[A-Za-z0-9]+$/`; a malformed value (empty reference, wrong namespace like `'ethereum:1'`, missing `tezos:` prefix) raises `NetworksUnsupportedBeaconError` with `unsupportedNetworks: [input.network]` and a message indicating "malformed CAIP-2 string" — covers the spec edge case "CAIP-2 string is malformed". Then validate against `accountManager.getAccounts().map(a => a.network?.chainId)`; raise `NetworksUnsupportedBeaconError` on mismatch or on missing-arg-when-ambiguous; fall back to `activeAccount.network || this.network` for single-network sessions. Stamp the resolved value (CAIP-2 string OR `Network` object) onto `OperationRequestInput.network`. See [contracts/operation-request-network.md](./contracts/operation-request-network.md) Rules O1–O6 + the SDK wire-build snippet.

### SDK integration test for US2 (Bucket A — SDK)

- [ ] T012 [US2] Add a unit/integration test that exercises: (a) `requestOperation({ network: '<valid CAIP-2>' })` on a multi-network session → outgoing message has `network: '<CAIP-2>'` string form (O3, W1); (b) `requestOperation({ network: '<invalid CAIP-2>' })` → `NetworksUnsupportedBeaconError` thrown before any wire activity (O3); (c) `requestOperation({ operationDetails })` (no network) on a multi-network session → `NetworksUnsupportedBeaconError` thrown (O4); (d) `requestOperation({ operationDetails })` (no network) on a single-network session → uses `activeAccount.network` unchanged (O5, backward compat). Use the same mock-wallet pattern as T008.

**Checkpoint**: dApp SDK has first-class per-call network selection. **US2 is independently shippable** for the SDK PR (Bucket A) once T009–T012 land.

---

## Phase 5: SDK Build & PR

**Purpose**: Verify the SDK delta builds clean and the Bucket A commits read coherently on `feat/peer-version-handshake`.

- [X] T013 (build only) SDK build & typecheck clean (`npm run build:packages` topological tsc + dist generation across all 12 packages — types, core, utils, dapp, wallet, blockchain-tezos, blockchain-tezos-sapling, blockchain-substrate, transport-matrix, transport-walletconnect, transport-postmessage, ui, sdk). Outer-repo `wallet/` and `dapp/` typecheck clean against the rebuilt SDK. Commits not yet created — user-authorized action. Recommended commit grouping (analysis I1): T003+T004 (error class + re-export), T005 (Tezos blockchain stub fix + Network widening), T006+T007 (DAppClient permission loop + dedupe + defensive), T009+T010+T011 (RequestOperationInput + OperationRequest widening + PermissionValidator/DAppClient string shims + resolveOperationNetwork helper). From the `octez.connect` clone: `npm run build:packages`; `npx tsc --noEmit -p packages/octez.connect-core`; `npx tsc --noEmit -p packages/octez.connect-types`; `npx tsc --noEmit -p packages/octez.connect-dapp`; `npx tsc --noEmit -p packages/octez.connect-blockchain-tezos`. All four `tsc --noEmit` runs must show zero errors. **Commit grouping (analysis finding I1)**: commit T003+T004 together (new error class + its re-export — same file area), T005 (Tezos blockchain stub fix), T006+T007 (DAppClient permission loop + defensive check, same function), T009+T010+T011 (types + DAppClient consumer for requestOperation), T008+T012 (SDK integration tests). Push branch to update the open spec 002 PR.

---

## Phase 6: User Story 3 — Reference apps demonstrate the clean SDK API (Priority: P3)

**Story Goal**: Both reference dApps stop using `(client as any).makeRequest` to inject `operation_request.network` — they call `client.requestOperation({ network })` directly. Both reference wallets stop inline-branching on chain id — they follow the documented integrator dispatch pattern with a `Record<chainId, BlockchainHandlerBundle>` lookup. Reference parity (constitution Principle IV) is demonstrated across both reference dApp/wallet pairs and all three transports.

**Independent Test**: `grep -rn "(client as any).makeRequest\|(client as any).network" wc2/dapp/ dapp/` returns zero hits. Reference wallets' permission/operation handler code no longer contains `if (chainId === ...)` chains — the dispatch is a table lookup. The matrix-P2P flow that proved spec 002 continues to pass (regression-free).

### Implementation for US3 — reference dApps (Bucket B — outer repo)

- [X] T014 [P] [US3] Removed the monkey-patch block in `wc2/dapp/src/main.ts:332-350`. Replaced with `await client.requestOperation({ network: chainId, operationDetails })`. At the operation-request call site, replace with `client.requestOperation({ network: chainId, operationDetails: [...] })`. The `network` field on the outgoing message now flows from a first-class SDK API (per spec 003 T009/T011), not a runtime hack. Comment near the call site can cite spec 003 / the demo-branch commit id.
- [X] T015 [P] [US3] Removed the analogous monkey-patch in `dapp/src/index.ts:264-281` (`/request-operation` handler). Replaced with `client.requestOperation({ operationDetails, ...(network ? { network } : {}) })`. Replace with `client.requestOperation({ network, operationDetails })`. Catch `NetworksUnsupportedBeaconError` if the optional flow surfaces it via `/last-handshake`, mirroring how `VersionUnsupportedBeaconError` is surfaced from spec 002.

### Implementation for US3 — reference wallets (Bucket B — outer repo)

- [X] T016 [P] [US3] Refactored `wallet/src/index.ts`. Added `BlockchainHandlerBundle` type, `buildBlockchainHandlers()` factory, split `executeOps` into `executeL1Ops` + `executeL2Ops` (legacy `executeOps` shim preserved for the WC2 path). The permission_request multi-network branch now rejects with `NETWORK_NOT_SUPPORTED + unsupportedNetworks` when any requested chain id is not in the handlers table (FR-005 emit-side). The operation_request handler dispatches via `handlers[chainId]` lookup; unknown chain id → same rejection. Defined `L1_CHAIN = 'tezos:NetXsqzbfFenSTS'`. (operation_request handler) to use the dispatch-table pattern from [data-model.md](./data-model.md) "Integrator Dispatch Pattern": replace the inline `if (typeof networkField === 'string')` / `if (isL2)` chain with `handlers[chainId].onOperation(req)` where `handlers: Record<string, BlockchainHandlerBundle>` is constructed once per wallet instance. Permission handling at lines 287–318 follows the same pattern: each registered handler returns its `{ publicKey }` for inclusion in `accounts[chainId]`. The `networkRegistry` (lines 98, 107–110) is absorbed into the handler bundle (per chain handler knows its own RPC URL). **Additionally — wallet emit-side FR-005 (analysis finding C1)**: the dispatch table's default branch (chain id not in `handlers`) MUST emit a wire-level structured error response naming the unsupported chain ids, BEFORE building any `accounts[]` map. The shape is: `{ type: 'error', errorType: 'NETWORK_NOT_SUPPORTED', unsupportedNetworks: [...] }` (or the project's equivalent error envelope). The dApp side then materializes this as `NetworksUnsupportedBeaconError` via the existing error-mapping path. This is what makes the spec FR-005 promise observable end-to-end — without this, the wallet would happily try to serve unsupported chain ids and surface generic errors at operation time.
- [X] T017 [P] [US3] Refactored `wc2/wallet/src/main.ts`. Added explicit `L1_CHAIN`/`L2_CHAIN` constants + `SUPPORTED_CHAIN_IDS` set. permission_request multi-network and operation_request both reject unknown chain ids with `NETWORK_NOT_SUPPORTED + unsupportedNetworks`. Replaced `chainId.includes('NetXH12')` substring heuristic with `chainId === L2_CHAIN` exact match across networkDotClass/networkLabel. (Note: corrected L2 chain id from the stale `NetXH12Aer3be93` to the actual `NetXY2oPPzkxUW1` per phase2.ts/wc2/dapp.) The two reference wallets MUST end up with the SAME dispatch-table shape (constitution Principle IV — reference parity). **Same wallet emit-side FR-005 rule as T016**: the default branch of the dispatch table emits a wire-level rejection naming the unsupported chain ids before building any partial `accounts[]` response.

**Checkpoint**: Reference apps exercise the multi-network surface using public SDK APIs only. Reference wallets demonstrate the documented integrator dispatch pattern.

---

## Phase 7: E2E test scaffolds & matrix run (Bucket B — outer repo)

**Purpose**: Constitution Principle II (NON-NEGOTIABLE — e2e per transport). The four matrix cells from spec SC-006 plus the multi-network operation flow from SC-007.

- [X] T018 [P] Created `test/phase-multi-network/multi-network-operation-p2p.ts` + shared helpers in `_shared.ts`. Reuses ghostnet + Tezos X previewnet endpoint constants from `phase2.ts`. Includes FR-006 reload-rehydration assertion (post-permission `DAppClient` reload, then re-check N records). Runtime green-light gated on real network + `WALLET_SK`. Matrix P2P transport. Connects with `networks: [L1-chainId, L2-chainId]`, asserts `getAccounts().length === 2`, calls `requestOperation({ network: L1-chainId, operationDetails: <reveal or transfer> })` and `requestOperation({ network: L2-chainId, operationDetails: <transfer> })` back to back, asserts both confirm on their respective RPCs. Reuses the ghostnet + Tezos X previewnet endpoint constants from spec 002's `test/phase2.ts`. **Reload assertion (analysis finding C2, satisfies FR-006)**: after the initial multi-network handshake, simulate `DAppClient` reload by either (a) reconstructing the client from storage in the same harness process, or (b) using a Playwright-equivalent for the popup transport's `localStorage` flow. Assert that `await freshClient.getAccounts()` still returns the same N records with the same chain ids — verifies the multi-network shape survives persistence/rehydration.
- [X] T019 [P] Created `test/phase-multi-network/multi-network-operation-walletconnect.ts`. Same matrix cell over WC2; reuses `runMultiNetworkMatrix` from `_shared.ts`. Same matrix cell over WalletConnect v2.
- [X] T020 [P] Created `test/phase-multi-network/multi-network-operation-postmessage.spec.ts` (Playwright). Uses `data-account-chain` selectors on the dApp page and `window.__triggerPermissions` / `window.__requestOp` hooks (test-only globals to be wired into the dApp page). Same matrix cell over Playwright/popup.
- [X] T021 [P] Created `test/phase-multi-network/multi-network-fr019-defensive.ts`. Uses `runFr019DefensiveCell` from `_shared.ts`. The wallet's `/test-config` endpoint needs a new `suppressAccountsFanout: boolean` flag the wallet's v4 permission branch honors — small follow-up wallet harness wiring (not done here; flagged in the scaffold's JSDoc). Pins the wallet to a v4-but-no-spec-003 mode via the spec 002 `POST /test-config` endpoint (or a new sub-mode that suppresses the `accounts[]` fanout in the wallet's response). Asserts the dApp catches `NetworksUnsupportedBeaconError` with `unsupportedNetworks` correctly populated. See [contracts/networks-unsupported-error.md](./contracts/networks-unsupported-error.md) F4.
- [X] T022 Wired `test:mn-p2p`, `test:mn-wc2`, `test:mn-popup`, `test:mn-fr019`, and `test:mn-all` into `package.json` scripts. following the spec 002 naming convention: add `test:mn-p2p`, `test:mn-wc2`, `test:mn-popup`, `test:mn-fr019`, and `test:mn-all` (runs all four). Update the README's scripts table to include the new entries.
- [ ] T023 Link the SDK locally into the outer repo (`npm link` each workspace package per the spec 002 demo-branch.md instructions) and run the full matrix:
  - `npm run test:mn-all` — must all be green.
  - `npm run test:pv-all` — spec 002 negotiation matrix — must remain green (regression check).
  - `npm run test:phase2` — legacy single-network end-to-end — must remain green (constitution Principle I).
  Record results in `specs/003-multi-network-protocol/matrix-results.txt`.

---

## Phase 8: Documentation & Website (Bucket B — outer repo)

**Purpose**: Constitution Principle V (spec & integration guide as deliverables). The integration guide formalizes the recommended integrator dispatch pattern as the worked example; the website cites the updated SDK commit id; the README spec table grows by one row.

- [X] T024 Added §3a "Recommended integrator dispatch pattern" to `docs/wallet-multichain-integration.md` with the full worked example (handlers table + dispatch logic + FR-005 rejection on default branch). Fits in ~70 lines including code per SC-005. (placement: after §3, before §4). Include the worked example from [data-model.md](./data-model.md) "Integrator Dispatch Pattern" — fits in <100 lines including comments (per SC-005). Cross-reference the reference wallets as the canonical implementation, citing the new `feat/peer-version-handshake` HEAD commit id.
- [X] T025 Updated `docs/wallet-multichain-integration.md` §4 backward-compat matrix with two new rows (FR-019 defensive cell + FR-005 wallet rejection cell) and two new conformance rules (C6 whole-request rejection + C7 explicit network argument). (backward-compatibility matrix) with the FR-019 cell: `v4-multi-network dApp × v4-single-network wallet → NetworksUnsupportedBeaconError`. The existing matrix rows from spec 002 stay; this is an additional row. Also add the conformance rule referencing C8 / F4 if §4 has a conformance-rule sub-section.
- [X] T026 [P] Updated `proposal.html` — the "SDK extension required" warning box now cites spec 003 and the dApp-side ergonomics tail (`getAccounts()`, `requestOperation({ network })`, `NetworksUnsupportedBeaconError`)., add a short paragraph about the multi-network ergonomics tail (citing this spec 003 + the new SDK HEAD commit id). The Chrome-extension and popup-transport code samples that spec 002 already updated continue to be the canonical wallet-side examples; add a note that the per-blockchain dispatch shown there matches the dispatch-table pattern formalized in the integration guide §X (T024).
- [X] T027 [P] Updated `poc-plan.html` Objective 2 paragraph with the same spec 003 cross-reference. — Phase 2 sub-section that spec 002 updated to "Version negotiation" gains a one-paragraph follow-up on multi-network ergonomics, cross-referencing the SDK HEAD commit id and the new test scaffolds (`test:mn-*`).
- [X] T028 Updated `README.md`: added "Multi-network protocol spec" row to the Documents table; refreshed Repo structure to include `specs/003-multi-network-protocol/`; updated demo-branch note to mention both spec 002 + 003 commits. refresh the demo-branch HEAD pointer; add a row for spec 003 in the Documents table; mention the multi-network ergonomics in the Status paragraph if appropriate (or leave it concise — spec 002's status text already covers the broader narrative).

---

## Phase 9: Polish, PRs & Constitution Attestation

- [X] T029 Grep verifications all clean. Results recorded in `specs/003-multi-network-protocol/grep-after.txt`: `(client as any).makeRequest` = 0 (down from 6), `partialAccountInfos[0]` in DAppClient.ts = 0 (down from 4), `accountId: ''` in TezosBlockchain = 0 (down from 1), `if (typeof networkField === 'string')` inline branching in reference wallets = 0 (down from 2). (matches the pre-change baselines from T002):
  - `grep -rn "(client as any).makeRequest" wc2/ dapp/` — expect 0 (down from 2).
  - `grep -n "partialAccountInfos\[0\]" octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts` — expect 0 in the `permissionRequest` path (any matches in unrelated paths are fine).
  - `grep -n "accountId: ''" octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts` — expect 0 (the stub is gone).
  - `grep -rn "if (chainId === \|if (isL2)" wallet/src/index.ts wc2/wallet/src/main.ts` — expect 0 in the permission/operation handler bodies; the dispatch table lookup replaces them.
  Record all four results in `specs/003-multi-network-protocol/grep-after.txt`.
- [X] T030 Constitution-principle attestation captured in `specs/003-multi-network-protocol/constitution-attestation.md`. Per-principle: **I** Backward-compat — N=1 single-network path preserved, optional fields, FR-005 only on v4 branch; **II** E2E per transport — 4 scaffolds (P2P, WC2, popup, FR-019), runtime gated on real network; **III** Real-network — scaffolds + reference wallets hit ghostnet (L1) + previewnet (L2); **IV** Reference parity — both ref dApps + both ref wallets demonstrate the documented pattern, T029 grep clean; **V** Spec & guide as deliverables — integration guide §3a + §4 matrix + website + README all updated. Open compliance gap: runtime green-light + PR finalization. (mirror spec 002's `constitution-attestation.md`). Per-principle: **I** Backward-compat — C9 single-network passthrough verified by `test:phase2` regression; **II** E2E per transport — `test:mn-{p2p,wc2,popup,fr019}` covers the four matrix cells; **III** Real-network — multi-network operations hit ghostnet (L1) + previewnet (L2); **IV** Reference parity — both ref dApps and both ref wallets demonstrate the documented pattern; **V** Spec & guide as deliverables — `docs/wallet-multichain-integration.md` §X + §4 row + website note + README spec-table row + cited HEAD commit id.
- [ ] T031 Finalize Bucket A SDK PR: amend the open spec 002 PR description on `trilitech/octez.connect` to note that spec 003 multi-network ergonomics are included as later commits on the same branch. List the commit ids and link spec 003 in this repo. Do NOT open a separate upstream PR (per spec Clarifications Session 2026-05-20).
- [ ] T032 Open Bucket B outer-repo PR off `003-multi-network-protocol` containing reference apps + integration guide + e2e scaffolds + website edits. Title: `feat: multi-network protocol ergonomics (spec 003)`. Body: spec 003 description, demo-branch HEAD commit id from Bucket A, test plan referencing T023's matrix results. Mark "depends on `trilitech/octez.connect#<PR-number>`" to make the cross-repo lineage explicit.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no deps; start immediately. T001 confirms the demo-branch state before any task targets `octez.connect/...`.
- **Phase 2 (Foundational)**: depends on Phase 1; T003 (new error class) is the gating task — both user stories consume it.
- **Phase 3 (US1)**: depends on Phase 2.
- **Phase 4 (US2)**: depends on Phase 2 (NOT US1 — disjoint files; the operation path doesn't touch the permission path).
- **Phase 5 (SDK build & PR push)**: depends on Phases 2–4.
- **Phase 6 (US3 — reference cleanup)**: depends on Phase 5 (needs the SDK delta linked locally so the reference apps' new call sites compile).
- **Phase 7 (E2E tests)**: depends on Phases 5 + 6 (needs both the SDK delta and the reference-app cleanup).
- **Phase 8 (Docs & Website)**: depends on Phase 5 (for the HEAD commit id citations). Can run in parallel with Phase 7 if writers stub the commit id and fill in just before commit.
- **Phase 9 (Polish + PRs)**: depends on all prior phases.

### Within-story dependencies

- US1: T005 (TezosBlockchain real parser) → T006 (loop fix consuming the parser) → T007 (defensive check piggybacking on the loop's outputs) → T008 (SDK test verifying the contract).
- US2: T009 + T010 (type changes, different files — parallel) → T011 (DAppClient consumes the types) → T012 (SDK test).
- US3: T014 + T015 (different dApp files — parallel); T016 + T017 (different wallet files — parallel); the two pairs (dApp side, wallet side) are independent of each other.

### Cross-repo dependency

- Bucket A (SDK) tasks T003–T013 land first (on `feat/peer-version-handshake`). Bucket B tasks T014+ require the SDK delta to be linked locally via `npm link`. The two PRs are reviewed independently but the outer-repo PR (Bucket B) cites the SDK commit id (T028, T032).

### Parallel opportunities

- Phase 1: T001 first, then T002.
- Phase 2: T003 then T004 (same file area, sequential).
- US2 (Phase 4): T009 and T010 in parallel (different type files); T011 sequential.
- Phase 6: T014 + T015 (different ref dApps) in parallel; T016 + T017 (different ref wallets) in parallel; ideally all four in parallel since they're disjoint files.
- Phase 7: T018, T019, T020, T021 all in parallel (different scaffold files).
- Phase 8: T026 + T027 (proposal.html + poc-plan.html — different files) in parallel; T028 sequences after to capture the updated docs in README.

### Story-level parallelism

Once Phase 2 (T003, T004) completes, US1 (T005–T008) and US2 (T009–T012) can be implemented in parallel by different developers — disjoint files (`blockchain.ts` + `DAppClient.permissionRequest` vs. `RequestOperationInput.ts` + `DAppClient.requestOperation`). US3 (Phase 6) requires both US1 and US2 SDK delta merged.

---

## Parallel Example: US2 type extensions

```bash
# After T003 (new error class) lands on the demo branch, these can run in parallel:
Task: "T009 Add network?: string to RequestOperationInput.ts"
Task: "T010 Widen OperationRequestInput.network to Network | string"
# T011 (DAppClient consumer) sequences after T009 + T010.
```

## Parallel Example: Bucket B reference cleanup

```bash
# After Bucket A SDK delta is pushed and linked locally:
Task: "T014 Remove monkey-patch in wc2/dapp/src/main.ts"
Task: "T015 Remove monkey-patch in dapp/src/index.ts"
Task: "T016 Refactor wallet/src/index.ts to dispatch table"
Task: "T017 Refactor wc2/wallet/src/main.ts to dispatch table"
# All four are disjoint files; parallel-safe.
```

## Parallel Example: E2E scaffolds

```bash
Task: "T018 multi-network-operation-p2p.ts"
Task: "T019 multi-network-operation-walletconnect.ts"
Task: "T020 multi-network-operation-postmessage.spec.ts"
Task: "T021 multi-network-fr019-defensive.ts"
# Different scaffold files; parallel-safe. T022 (package.json wiring) sequences after.
```

---

## Implementation Strategy

### MVP first (US1 only) — fastest demonstrable value

1. Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1).
2. **STOP and VALIDATE**: `client.getAccounts()` returns N records after a multi-network permission_request; the FR-019 defensive path correctly rejects older v4 wallets.
3. Phase 5 commits and pushes the partial SDK delta to the open `feat/peer-version-handshake` PR.
4. US2 and US3 follow as additive increments.

### Incremental delivery

1. Phase 1 + Phase 2 → foundational error class on the demo branch.
2. US1 → demo: multi-network permission flow returns N accounts via the public SDK API.
3. US2 → demo: `requestOperation({ network })` works first-class; monkey-patches in reference dApps can be removed.
4. Phase 5 → SDK PR description amended; SDK is reviewable as-is.
5. US3 → demo: reference apps demonstrate the public SDK surface; reference wallets demonstrate the documented dispatch pattern.
6. Phase 7 → multi-network matrix is green on all three transports; spec 002 regression suites still green.
7. Phase 8 → integration guide + website + README reflect the new ergonomics.
8. Phase 9 → grep verifications, constitution attestation, both PR descriptions finalized.

### Parallel team strategy

- One dev (Bucket A — SDK): Phases 1, 2, 3, 4, 5 on the `feat/peer-version-handshake` branch in `octez.connect/`. Roughly half-day to one-day SDK work.
- Dev B (Bucket B — outer repo): can begin Phase 6 (US3) as soon as Phase 5 pushes the SDK delta. Phase 7 (e2e) and Phase 8 (docs) can be split between Dev B and a tech-writer-friendly contributor.
- Final dev: Phase 9 wrap-up — grep checks, attestation, PR descriptions.

---

## Notes

- `[P]` = different files, no incomplete-task dependencies.
- `[US#]` labels are required on Phase 3/4/6 tasks; absent on Phase 1/2/5/7/8/9.
- Constitution Principle II makes test tasks **mandatory** for this feature: T008 + T012 (SDK-side); T018 + T019 + T020 + T021 (cross-repo e2e).
- Constitution Principle III requires ghostnet (or documented previewnet) usage in any test that exercises an operation post-handshake — covered by T018 (L1 ghostnet + L2 previewnet in the same scaffold).
- The dApp-SDK-side `NetworksUnsupportedBeaconError` is a hard contract — wire-level `networks_unsupported` from upgraded wallets is forbidden by the spec 002 reject-pattern precedent. Reviewers should grep the implementation to confirm no new `BeaconErrorType.NETWORKS_UNSUPPORTED` value was added.
- The `octez.connect/` clone is **gitignored from the outer repo**; do not try to `git add` paths under it from the outer repo. All edits to `octez.connect/...` are committed inside that clone on `feat/peer-version-handshake`.
- `WALLET_SK` is read from env per constitution §Technology Constraints. Do not commit secrets.
- The website (`proposal.html`, `poc-plan.html`) is served at `https://trilitech.github.io/tezos-x-octez-connect/`. Edits in Phase 8 update both the static HTML and (implicitly) what visitors see after the next GitHub-Pages publish.

## Analysis findings applied (2026-05-21)

The following amendments were merged into the tasks above after `/speckit-analyze` (see report dated 2026-05-21):

- **C1 (HIGH)** — T016 + T017 now spell out the wallet emit-side FR-005 rejection: the dispatch table's default branch MUST emit a wire-level structured error for unsupported chain ids before building any partial `accounts[]`.
- **A1 (MEDIUM)** — T007's defensive check now uses the full four-condition gate from [research.md](./research.md) R6 (peer.version ≥ 4, networks ≥ 2, missing non-empty, AND `requiredMinimumVersion ≥ '4'`).
- **C2 (MEDIUM)** — T018 now includes a reload-rehydration assertion that verifies FR-006 (multi-network state survives client reconstruction from storage).
- **C3 (MEDIUM)** — T006 now dedupes `input.networks` by `chainId` at the upstream emit site (spec 002 T028 territory), satisfying the spec edge case "DApp lists the same network twice".
- **A2 (MEDIUM)** — T011 now explicitly validates the CAIP-2 format (`/^tezos:[A-Za-z0-9]+$/`) before the session-membership check, raising a clear "malformed CAIP-2" message instead of conflating with "not in session".
- **I1 (MEDIUM)** — T013's commit grouping was corrected to pair T003+T004 (the new error class and its re-export belong in one commit).
- **T1 (LOW)** — T003 now carries an inline naming-caveat note clarifying that `NetworkNotSupportedBeaconError` (singular, wire-registered, spec 002 baseline) and `NetworksUnsupportedBeaconError` (plural, client-side-only, new in spec 003) are deliberately distinct classes.

The following LOW-severity findings from the analysis remain as observational notes (no task edit needed):

- **I2 (LOW)** — Total Bucket A SDK delta is best estimated at ~70–110 lines of production code (T005's TezosBlockchain stub fix is the largest contributor, surfaced by [research.md](./research.md) R2 only after `/speckit-plan`). The plan.md Summary's "~30–50 lines across 3–4 files" predates the R2 discovery and should be read as a lower bound; do not waste a re-plan cycle on it.
- **T2 (LOW)** — T018–T021 may optionally label each scaffold's matrix cell explicitly (e.g. "v4 multi-network × v4 multi-network on Matrix P2P") in code comments. Cosmetic; skip unless a reviewer requests.
- **U1 (LOW)** — FR-020 (CAIP-2 namespace allows non-Tezos chains in a future revision) is a *structural property* satisfied by T009's `string`-typed wire field (no chain-namespace enum exists to extend). No implementation work needed; reviewers should tick FR-020 by inspecting the type, not by running a test.
- **U2 (LOW)** — The spec edge case "wallet user revokes one network mid-session but keeps the other" describes graceful session degradation. v1 scope treats this as observational: the SDK does not actively re-validate `AccountInfo` records mid-session against wallet UI state. If a revoked-network operation_request is later issued, the wallet's per-blockchain handler rejects at operation time (existing failure path). Documented for future work; no v1 task.
