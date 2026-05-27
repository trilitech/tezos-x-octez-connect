# Implementation Plan: PR #31 CI Failures & Review Comment Remediation

**Branch**: `004-fix-pr31-ci-and-review` | **Date**: 2026-05-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-fix-pr31-ci-and-review/spec.md`

## Summary

Land the additive remediation commits on top of `trilitech/octez.connect#31` (head `feat/peer-version-handshake @ 38afc2c9`) so both required CI checks (`build-and-unit`, `end-to-end`) go green and all 11 Copilot review threads resolve to a fix or substantive reply. The work is six discrete edits across five packages plus an e2e hook fix, all confined to lines this PR already touched: a tightened `compareBeaconVersion()` contract (throws `InvalidBeaconVersionError` on malformed input), a wallet-side `try/catch` + `logger.warn` guard in `IncomingRequestInterceptor.intercept()`, awaiting of all three V*Message handlers, a typed `networks?` field on `PermissionRequest`/`PermissionRequestInput` (removing the `as any` cast), de-duplication of the version assertion in `requestPermissions()`, switching the Tezos blockchain's `accountId` derivation from `deriveAccountId(publicKey, chainId)` to `getAccountIdentifier(address, network)` (with a new `StalePermissionSchemeError` for pre-fix on-disk entries), a JSDoc correction on `requiredMinimumVersion`, the missing barrel export of `RequestPermissionNetwork`, an `e2e/wc-flow.spec.ts` `afterEach` resilience fix, plus the 5+ new Jest cases the spec requires. The 46 `lint:new` findings are addressed in-line by the same edits (since every flagged line either becomes typed, is wrapped in a block, or is annotated correctly). No protocol wire change. No wallet-side change. No `eslint-disable` suppressions.

## Technical Context

**Language/Version**: TypeScript ~5.x (workspace monorepo)

**Primary Dependencies**:
- `@tezos-x/octez.connect-{core,types,dapp,wallet,blockchain-tezos,blockchain-substrate,blockchain-tezos-sapling}` (the six packages this remediation touches, of the 12 in the `octez.connect` workspace)
- ESLint (the `lint:new` gate runs `node scripts/lint-new-findings.mjs` against `PR_BASE_SHA`)
- Jest 29.x for `octez.connect-dapp` unit suite
- Playwright for `e2e/` (chromium project, 2 workers, 25 tests total)
- WalletConnect v2 (`@walletconnect/sign-client`) for `wc-flow.spec.ts`

**Storage**: localStorage (dApp-side `PermissionInfo` persistence via Beacon's storage abstraction; key impacted by C10 → see FR-011a)

**Testing**:
- `npm run lint:new` — the gate that currently fails with 46 findings
- `npm run test` (Jest) per package — `octez.connect-dapp` is the one that needs new cases
- `npm run e2e:smoke` (`playwright test e2e --grep-invert @extended`) — 25 tests, currently 24 pass + 1 fails (`wc-flow.spec.ts:17`)
- The multi-network e2e cell in `trilitech/tezos-x-octez-connect#4` against ghostnet + Tezos X previewnet is the real-network gate per Constitution Principle III (out-of-band; not run by the SDK's CI)

**Target Platform**: Browser-side SDK (evergreen Chrome/Firefox/Safari); also runs in Node for unit tests. The reference dApp/wallet in this companion repo (Vite + TypeScript) is the integration surface.

**Project Type**: TypeScript library monorepo (12 packages, npm workspaces). Spec planning artifacts live in this repo (`trilitech/tezos-x-octez-connect`); code changes target the sibling repo `trilitech/octez.connect`. Both are cloned locally at `/home/ubuntu/projects/tezos-x-octez-connect/octez.connect/`.

**Performance Goals**: N/A — remediation is correctness, type-safety, and observability; not throughput or latency.

**Constraints**:
- `lint:new` gate MUST report `0 new finding(s)` (SC-003)
- 24 existing `base-flow` + `p2p-flow` e2e cells MUST continue passing on the remediation head (SC-006)
- Backward-compatibility matrix in PR #31 body MUST hold byte-for-byte (FR-014)
- No `eslint-disable` suppressions without inline justification (FR-018)
- No protocol wire change; the v4 wire format and the wallet implementation are out of scope (locked in Clarifications, Session 2026-05-22)

**Scale/Scope**: 6 source-code files edited, 1 e2e file edited, 2 new error classes added, ≥ 5 new Jest cases. Approximately 200–400 LOC delta, primarily replacing `any` casts with typed shapes and adding small helper functions. No new packages, no new build steps.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluating against the five principles from `.specify/memory/constitution.md` v1.0.0:

| Principle | Verdict | Reasoning |
|---|---|---|
| **I. Backward-Compatible Protocol Extensions** | PASS | The remediation does NOT touch the wire. `compareBeaconVersion()` was already throwing; the change tightens the *throw conditions* (malformed inputs now throw with a typed error instead of a generic `Error`). The new typed `networks?` field on `PermissionRequest` was already optional via `as any`; it now becomes optional via the type system. The C10 `accountId` change is a dApp-side internal scheme change — the v4 wire format is unchanged. `StalePermissionSchemeError` (FR-011a) is a new SDK-side error class, not a wire field. |
| **II. End-to-End Validation Per Transport (NON-NEGOTIABLE)** | PASS WITH NOTE | This remediation is not a protocol or transport change — it is a code-quality + type-safety + observability pass on top of the already-merged-into-PR protocol change. None of the edits cross the wire. The accountId scheme change is internal to the dApp's persistence layer. **The single thing on the boundary is the wc-flow afterEach fix + investigation**, which the spec explicitly requires (FR-002). Matrix-P2P e2e is already validated via `tezos-x-octez-connect#4`; tzip10-popup is not exercised by PR #31 and is not in scope. |
| **III. Real-Network Operations, Not Mocks** | PASS | The new Jest cases (FR-012, FR-013) verify dApp-side state-machine behaviour (`requiredMinimumVersion` validation, N-account fanout, FR-019 defensive gate) — none sign or inject operations. The real-network gate continues to be the existing multi-network cell in `tezos-x-octez-connect#4`. |
| **IV. Reference Implementation Parity** | PASS | No new protocol field, behaviour, or error code added that wallets/dApps need to handle. The two new error classes are SDK-internal. The reference dApp/wallet in `tezos-x-octez-connect#4` will pick up the C10 fix automatically when the SDK pin is bumped. |
| **V. Spec & Integration Guide As Deliverables** | PASS WITH NOTE | The remediation does not change protocol surface or transport message shapes. However, the new dApp-side error `StalePermissionSchemeError` will be observable to integrators during the v4 upgrade window. **A one-paragraph note in `docs/wallet-multichain-integration.md` flagging "if you paired under v4 before this fix, you will see `StalePermissionSchemeError` on the next operation request — re-pair to resolve" is a soft deliverable** captured in Complexity Tracking below. |

All five principles PASS. No unjustified violations. No work blocked.

## Project Structure

### Documentation (this feature)

```text
specs/004-fix-pr31-ci-and-review/
├── plan.md              # This file
├── spec.md              # Feature specification (already complete)
├── research.md          # Phase 0 output — investigation steps + decisions
├── data-model.md        # Phase 1 output — type-surface deltas (errors, fields)
├── quickstart.md        # Phase 1 output — how to run the gates locally
├── contracts/
│   └── compare-beacon-version.md   # Tightened contract for the version-compare util
└── checklists/
    └── requirements.md  # Spec quality checklist (already complete)
```

### Source Code (target repository: `trilitech/octez.connect`, locally at `/home/ubuntu/projects/tezos-x-octez-connect/octez.connect/`)

```text
octez.connect/
├── packages/
│   ├── octez.connect-core/
│   │   └── src/
│   │       ├── errors/
│   │       │   ├── InvalidBeaconVersionError.ts        # NEW (Q1)
│   │       │   ├── StalePermissionSchemeError.ts       # NEW (Q3, FR-011a)
│   │       │   ├── VersionUnsupportedBeaconError.ts    # existing
│   │       │   ├── InvalidRequiredMinimumVersionError.ts # existing
│   │       │   ├── NetworksUnsupportedBeaconError.ts   # existing — lint fixes (no-use-before-define, prefer-arrow)
│   │       │   └── error-codes.ts                       # add codes for new errors
│   │       ├── utils/
│   │       │   └── message-utils.ts                     # FR-006: tighten compareBeaconVersion
│   │       ├── managers/
│   │       │   └── PermissionValidator.ts               # FR-011a: emit StalePermissionSchemeError
│   │       └── index.ts                                 # export new errors
│   ├── octez.connect-types/
│   │   └── src/
│   │       ├── types/
│   │       │   ├── RequestPermissionInput.ts            # (already correct)
│   │       │   └── beacon/messages/PermissionRequest.ts # FR-008: add typed `networks?` field
│   │       └── index.ts                                 # FR-007: barrel-export RequestPermissionNetwork
│   ├── octez.connect-dapp/
│   │   ├── src/dapp-client/
│   │   │   ├── DAppClient.ts                            # FR-008/FR-010 (de-cast, consolidate assertion); FR-011 caller; all `any` cleanups
│   │   │   └── DAppClientOptions.ts                     # FR-009: JSDoc correction
│   │   └── __tests__/dapp-client/
│   │       └── DAppClient.test.ts                       # FR-012/FR-013: new Jest cases
│   ├── octez.connect-wallet/
│   │   └── src/interceptors/
│   │       └── IncomingRequestInterceptor.ts            # FR-004 (await handlers), FR-005 (try/catch + warn log), lint cleanups
│   ├── octez.connect-blockchain-tezos/
│   │   └── src/blockchain.ts                            # FR-011: replace deriveAccountId with getAccountIdentifier; lint cleanups (prefer-arrow, padding, no-use-before-define, any)
│   ├── octez.connect-blockchain-substrate/
│   │   └── src/blockchain.ts                            # remove unused `_peerVersion` param
│   └── octez.connect-blockchain-tezos-sapling/
│       └── src/blockchain.ts                            # remove unused `_peerVersion` param
└── e2e/
    ├── wc-flow.spec.ts                                  # FR-002: resilient afterEach
    └── utils.ts                                          # touched if pairWithWCWallet needs to assign-on-throw
```

**Structure Decision**: TypeScript library monorepo. All edits land on the existing `feat/peer-version-handshake` branch (no fresh stacked branch — locked in spec Assumptions). Spec planning artifacts (this directory) live in the companion repo `trilitech/tezos-x-octez-connect`; the actual code changes are pushed to the sibling repo `trilitech/octez.connect`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No hard constitutional violations. Two soft notes captured here for traceability:

| Note | Why kept | Mitigation |
|------|----------|-----------|
| Principle II "per-transport e2e" not extended to tzip10-popup; potentially not extended to WC2 either if `wc-flow.spec.ts:17` ends up quarantined per T011 | The remediation does not touch popup-specific code paths and PR #31 does not include popup in its CI. Re-running every transport for a lint+typing+observability pass would inflate the PR with no signal. | The matrix-P2P transport is exercised by `base-flow` + `p2p-flow` (24 passing cells). WC2 is exercised by `wc-flow.spec.ts` after the `afterEach` fix — **unless** T004's master-side reproduction declares the `wc-flow.spec.ts:17` failure pre-existing, in which case T011 quarantines that single test and WC2 falls back to the same arrangement as popup: covered by `tezos-x-octez-connect#4`'s e2e harness, which pins the SDK and re-runs after merge. Either way, WC2 + popup parity is owned by the companion repo's e2e cells; this PR's CI guarantees matrix-P2P unconditionally. |
| Principle V "integration guide as deliverable" not strictly triggered, but `StalePermissionSchemeError` is integrator-observable | The new error is SDK-internal in implementation, but a dApp developer who has paired under v4 before this fix will see it in their console on first OperationRequest after the upgrade. | Add a one-paragraph note to `docs/wallet-multichain-integration.md` (in **this** repo, `tezos-x-octez-connect`) describing the error and the "re-pair to upgrade" remediation. This is captured as a planning task in `tasks.md` so it doesn't slip. |
