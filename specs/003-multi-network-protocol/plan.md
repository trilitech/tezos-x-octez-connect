# Implementation Plan: Multi-Network Protocol Support for Beacon v4

**Branch**: `003-multi-network-protocol` | **Date**: 2026-05-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-multi-network-protocol/spec.md`

## Summary

Spec 002 (peer-version-handshake) bumped `BEACON_VERSION` to `'4'`, established `peer.version`-based single-branch routing on the wallet, plumbed `networks?: RequestPermissionNetwork[]` through `requestPermissions`, and stubbed `handleV4Message` that today delegates to `handleV3Message` for envelope plumbing. Spec 003 fills the **dApp-side ergonomics gap** that remained after 002:

1. **Stop the `partialAccountInfos[0]` slice** in `DAppClient.permissionRequest` — persist every account the wallet returned (one `AccountInfo` per chain id) so `getAccounts()` and `setActiveAccount()` work natively for a multi-network session.
2. **Add `network?: string` (CAIP-2)** to `RequestOperationInput` and plumb it through `DAppClient.requestOperation` so dApps can target a specific network per call — removing the `(client as any).makeRequest = …` monkey-patch the reference dApps currently carry.
3. **Structured rejection error** for the case where a wallet cannot serve every requested network (FR-005). Reuses or extends the existing `NetworkNotSupportedBeaconError`; resolved in [research.md](./research.md) R1.
4. **Defensive shape-mismatch detection** (FR-019) — when a v4 wallet response lacks the `accounts[]` fanout (older v4 wallet built against spec 002 but not 003), raise a structured error rather than silently accepting a single-network response.
5. **Reference dApps/wallets** demonstrate the new API surface end-to-end — monkey-patches removed; reference wallets' inline `if (chainId === ...)` reorganized into the **documented integrator dispatch pattern** (see [data-model.md](./data-model.md) Integrator Dispatch Pattern).
6. **Integration guide** (`docs/wallet-multichain-integration.md`) gains the recommended integrator pattern as a worked example; **website** (`proposal.html`, `poc-plan.html`) cross-references the updated demo-branch HEAD commit id.

**Delivery shape** (per spec Clarifications Session 2026-05-20):

- **Bucket A — SDK delta**: ~30–50 lines across 3–4 files in `octez.connect/packages/*` — ships as **incremental commits on the open `feat/peer-version-handshake` PR** in `trilitech/octez.connect`. No new upstream PR.
- **Bucket B — Outer repo**: reference dApps + wallets + integration guide + website + e2e harness — ships as **a new PR** in `tezos-x-octez-connect` off this `003-multi-network-protocol` branch.

The wallet SDK is **intentionally unchanged** beyond what spec 002 already shipped — per-blockchain handler dispatch remains the integrator's responsibility, formalized as a documented pattern, not lifted into the SDK (Clarifications Q1).

## Technical Context

**Language/Version**: TypeScript 5.x (per existing octez.connect packages and reference implementations).

**Primary Dependencies**:
- `@tezos-x/octez.connect-core` (`octez.connect/packages/octez.connect-core`) — owns the existing `NetworkNotSupportedBeaconError`; the spec 003 rejection error either reuses it or extends it (research R1).
- `@tezos-x/octez.connect-dapp` — `DAppClient.permissionRequest()` and `DAppClient.requestOperation()` are the two methods being modified. AccountManager (existing) handles per-`accountIdentifier` storage; no schema change.
- `@tezos-x/octez.connect-types` — `RequestOperationInput.ts` gains an optional `network?: string` field. `RequestPermissionInput` (from spec 002) is unchanged.
- `@tezos-x/octez.connect-wallet` — **no changes** (per Clarifications Q1).
- `@tezos-x/octez.connect-transport-*` — no transport-level wire changes; `network` rides on the existing `OperationRequest` envelope.
- Reference dApps/wallets: `wc2/dapp/`, `wc2/wallet/`, `dapp/`, `wallet/`.

**Storage**: Existing `PeerManager` (browser `localStorage` via `octez.connect-core` storage abstraction). Existing `AccountManager.addAccount()` keys on `accountIdentifier`. Multi-network state is achieved by storing N `AccountInfo` records (one per chain id) under distinct `accountIdentifier`s — the wallet's response already constructs distinct public keys per chain (`wallet/src/index.ts:294-300`), so the identifiers are naturally distinct. No schema change.

**Testing**:
- Existing phase tests in `test/phase{1,2,5,6}.ts` + the spec 002 negotiation matrix scaffolds at `test/phase-version-negotiation/`.
- New multi-network operation scaffolds under `test/phase-multi-network/` exercising L1+L2 in one session and per-network operation targeting.
- Playwright continues to drive popup-transport tests.

**Target Platform**: Evergreen browsers (Chrome, Firefox, Safari latest stable) for dApp/wallet UIs; Node 18+ for `tsx`-driven harness scripts. Same as spec 002.

**Project Type**: Monorepo. Protocol-extension POC: published SDK packages (under `octez.connect/packages/`) + reference dApp/wallet implementations + e2e phase tests + protocol documentation + GitHub-Pages website.

**Performance Goals**: No new round-trips. Multi-network permission completes in the same single round-trip as spec 002 (`requestPermissions` with `networks[]` is a v4 enhancement on the existing handshake). Per-operation network selection adds zero latency — it's a field on the existing `operation_request`.

**Constraints**:
- TZIP-10 v2 byte-for-byte compatibility on `peer.version = '3'` (constitution Principle I, FR-017).
- No new fields on any pairing payload or message envelope. The `networks[]` (permission_request) and `network` (operation_request) fields already exist per spec 002 / TZIP-10 v3 wire shape.
- Cross-transport parity is non-negotiable (constitution Principle II, FR-019, SC-006).
- `partialAccountInfos[0]` slice removal MUST NOT regress the legacy v3 single-network path (FR-017): a v3 wallet returns exactly one `partialAccountInfo`, and the new loop must handle the N=1 case identically to today.
- The wallet SDK's public surface MUST NOT gain a handler registry (FR-012, Clarifications Q1).

**Scale/Scope**: Internal POC scale. Two reference dApps × two reference wallets × three transports. Two Tezos networks in the matrix (Tezos L1 ghostnet + Tezos X L2 previewnet). No production-traffic SLOs apply.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0.

| # | Principle | Result | Notes |
|---|-----------|--------|-------|
| I | Backward-Compatible Protocol Extensions | ✅ Pass | The `partialAccountInfos[0]` slice removal preserves N=1 behavior byte-for-byte (legacy v3 wallet returns exactly one record; loop produces one `AccountInfo`; existing `setActiveAccount()` flow unchanged). The new `network?: string` on `RequestOperationInput` is optional — single-network dApps continue to call `requestOperation({ operationDetails })` with no network argument and get today's `activeAccount.network` fallback (FR-011). FR-005 rejection error fires only on v4 multi-network responses; v3 path is untouched. |
| II | End-to-End Validation Per Transport (NON-NEGOTIABLE) | ⚠ Plan-pass; gated at Phase 1 | The implementation MUST land with passing e2e tests on all three transports for the v4 multi-network matrix cell. Quickstart Step 8 + tasks.md will encode this. SC-006 names the exact cells. |
| III | Real-Network Operations, Not Mocks | ✅ Pass-by-construction | The multi-network flow's value is exercised by issuing operations on two networks in one session. Both must hit real RPCs (ghostnet for L1, Tezos X previewnet for L2). SC-007 makes this explicit. |
| IV | Reference Implementation Parity | ⚠ Plan-pass; gated at Phase 1 | Both reference dApps remove the `(client as any).makeRequest` monkey-patch; both reference wallets reorganize their per-network code to match the documented integrator pattern. Three transports × two reference apps each = the full parity surface. Tracked in Bucket B tasks. |
| V | Spec & Integration Guide As Deliverables | ⚠ Plan-pass; gated at Phase 1 | `docs/wallet-multichain-integration.md` gains the integrator dispatch pattern as §X (worked example); `proposal.html` + `poc-plan.html` updated to cite the new demo-branch HEAD; backward-compat matrix in the integration guide §4 amended with the v4-multi-network × v4-single-network defensive cell (FR-019). |

**Gate**: PASS to Phase 0. Three principles (II, IV, V) carry plan-pass status pending Phase 1 + Phase 2 task fulfillment — same pattern as spec 002.

## Project Structure

### Documentation (this feature)

```text
specs/003-multi-network-protocol/
├── plan.md                   # This file (/speckit-plan output)
├── research.md               # Phase 0 output (/speckit-plan)
├── data-model.md             # Phase 1 output (/speckit-plan)
├── quickstart.md             # Phase 1 output (/speckit-plan)
├── contracts/                # Phase 1 output (/speckit-plan)
│   ├── multi-network-permission.md
│   ├── operation-request-network.md
│   └── networks-unsupported-error.md
├── checklists/
│   └── requirements.md       # /speckit-specify validation result
├── spec.md                   # /speckit-specify output
└── tasks.md                  # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (cross-repo layout)

```text
# Bucket A — SDK delta (lands as incremental commits on the open
# feat/peer-version-handshake PR in trilitech/octez.connect)
octez.connect/                                     # vendored clone (gitignored from outer repo)
└── packages/
    ├── octez.connect-types/src/types/
    │   └── RequestOperationInput.ts               # +network?: string (CAIP-2)
    ├── octez.connect-dapp/src/dapp-client/
    │   └── DAppClient.ts                          # permissionRequest loop fix + requestOperation network plumbing + FR-019 defensive
    └── octez.connect-core/src/errors/
        ├── NetworkNotSupportedBeaconError.ts      # reuse or augment (research R1)
        └── (possibly) NetworksUnsupportedBeaconError.ts  # new class if R1 selects "add a new error"

# Bucket B — Outer repo (lands as a new PR in tezos-x-octez-connect off
# branch 003-multi-network-protocol)
.                                                  # repo root
├── dapp/src/index.ts                              # remove monkey-patch; use client.requestOperation({ network })
├── wc2/dapp/src/main.ts                           # remove monkey-patch; use client.requestOperation({ network })
├── wallet/src/index.ts                            # reorganize per-network logic into integrator dispatch pattern
├── wc2/wallet/src/main.ts                         # ditto
├── test/phase-multi-network/                      # NEW: e2e scaffolds for multi-network operation flow
│   ├── multi-network-operation-p2p.ts
│   ├── multi-network-operation-walletconnect.ts
│   └── multi-network-operation-postmessage.spec.ts
├── docs/wallet-multichain-integration.md          # +integrator dispatch pattern (FR-013); backward-compat matrix updated
├── proposal.html                                  # cite updated demo-branch HEAD; mention multi-network ergonomics tail
├── poc-plan.html                                  # same
└── README.md                                      # demo-branch pointer refreshed
```

**Structure Decision**: Two-bucket cross-repo delivery, mirroring the spec 002 split but with two distinct PR-targets (instead of spec 002's single-feature-branch + single demo-branch). Bucket A advances the existing upstream PR; Bucket B is its own outer-repo PR. The two PRs are reviewable independently; cross-references are the `npm link` linkage during e2e testing and the demo-branch HEAD commit id cited in Bucket B's docs.

## Phase 0: Outline & Research

Open technical questions resolved in [research.md](./research.md):

| Id | Question | Resolution location |
|----|----------|---------------------|
| R1 | Reuse `NetworkNotSupportedBeaconError` for FR-005, or add a new `NetworksUnsupportedBeaconError`? | research.md R1 |
| R2 | What does `getAccountInfosFromPermissionResponse()` return today — already N records, or one? | research.md R2 |
| R3 | How does `AccountManager.addAccount()` behave with multiple records per peer? `accountIdentifier` collision risk? | research.md R3 |
| R4 | Wire-level field shape for `operation_request.network` — CAIP-2 string vs legacy `Network` object; backward compat? | research.md R4 |
| R5 | Canonical shape for the integrator dispatch pattern documented in the integration guide | research.md R5 |
| R6 | FR-019 detection criteria: how does the dApp SDK distinguish "v4 wallet missing `accounts[]` fanout" from "legitimate v4 single-network response"? | research.md R6 |

**Output**: [research.md](./research.md) — all six resolved with citations.

## Phase 1: Design & Contracts

**Prerequisites**: [research.md](./research.md) complete.

Phase 1 deliverables:

1. **[data-model.md](./data-model.md)**: Entities involved in the design:
   - `AccountInfo` (existing — used multi-instance per session)
   - `RequestOperationInput` (extended)
   - `OperationRequest` wire shape (existing field repurposed)
   - The error class chosen by R1 (shape, fields, when raised)
   - **Integrator dispatch pattern** (informative — the shape for the integration guide's worked example)

2. **Contracts** under `/contracts/`:
   - `multi-network-permission.md` — wire contract on `permission_request.networks[]` and `permission_response.accounts[chainId]`. Most of this is inherited from spec 002 T028; this contract formalizes the *response shape* that spec 003 stops slicing.
   - `operation-request-network.md` — wire and SDK contract for the v4 per-call network selector.
   - `networks-unsupported-error.md` — error contract for FR-005 (selected error class from R1).

3. **[quickstart.md](./quickstart.md)**: Step-by-step recipe for an implementer to verify the feature end-to-end:
   - Steps 1–5: SDK delta (Bucket A) with concrete file paths and diff sketches.
   - Steps 6–8: Outer-repo work (Bucket B): reference apps cleanup, integration guide pattern, e2e harness.
   - Step 9: Cross-bucket verification (link the SDK locally, run the matrix).

4. **Agent context update**: `CLAUDE.md` plan pointer updated from spec 002 to spec 003.

## Complexity Tracking

No constitution violations expected; this row exists only because the plan template requires the section.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)*  | *(n/a)*    | *(n/a)*                              |

**Rationale for no violations**: The narrowing from Clarifications Q1 specifically removed the work item (wallet SDK handler registry) that would have introduced new API surface area on the wallet SDK — keeping the SDK boundary thin. All remaining work is either (a) bug-fixes-as-API-cleanup on the dApp SDK (the `partialAccountInfos[0]` slice and the missing `network` argument), or (b) integrator-side reorganization documented as a pattern, not enforced by the SDK. The constitution's five principles are satisfied additively rather than by exception.
