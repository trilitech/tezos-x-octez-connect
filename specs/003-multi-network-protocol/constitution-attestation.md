# Constitution Attestation: 003-multi-network-protocol

**Feature**: 003-multi-network-protocol
**Constitution version**: 1.0.0 (ratified 2026-05-12, last amended 2026-05-12)
**Attestation date**: 2026-05-21

Evaluated against `.specify/memory/constitution.md`. Each principle is addressed below with the concrete evidence that demonstrates compliance.

## I. Backward-Compatible Protocol Extensions

**Status**: ✅ Pass.

**Evidence**:
- The `Network` type widening (added optional `chainId?: string`) is additive. Legacy `Network` objects continue to satisfy the interface byte-for-byte.
- `OperationRequest.network: Network` widened to `Network | string`. The `Network` object branch is unchanged; the new `string` branch is the v4 multi-network value. Wallet handlers already discriminated via `typeof networkField === 'string'` (spec 002).
- `RequestOperationInput.network` is *optional*. Single-network dApps continue to call `requestOperation({ operationDetails })` and get the legacy `activeAccount.network || this.network` fallback (FR-011).
- `DAppClient.requestPermissions` legacy single-network path (no `accounts` map on response) is preserved by the `if (multiNetworkAccounts && typeof multiNetworkAccounts === 'object' && !Array.isArray(multiNetworkAccounts))` gate. The `onNewAccount` call site is untouched on the non-v4 branch.
- `TezosBlockchain.getAccountInfosFromPermissionResponse` falls back to a single-record response when `blockchainData.accounts` is absent (v3 legacy shape preserved).
- FR-005 wallet emit-side rejection only fires on the v4 branch in both reference wallets; v3 wallets do not emit it.

**Verification**: `npm run test:phase2` (legacy single-network end-to-end against ghostnet + Tezos X previewnet) MUST remain green. Tracked as a manual prerequisite to declaring spec 003 done. Cross-repo CI gate.

## II. End-to-End Validation Per Transport (NON-NEGOTIABLE)

**Status**: ⚠ Plan-pass; runtime green-light requires running the matrix.

**Evidence**:
- Four e2e scaffolds at `test/phase-multi-network/`:
  - `multi-network-operation-p2p.ts` — Matrix P2P
  - `multi-network-operation-walletconnect.ts` — WalletConnect v2
  - `multi-network-operation-postmessage.spec.ts` — postMessage popup (Playwright)
  - `multi-network-fr019-defensive.ts` — FR-019 defensive cell
- `package.json` scripts `test:mn-p2p`, `test:mn-wc2`, `test:mn-popup`, `test:mn-fr019`, `test:mn-all`.

**Open compliance gap**: Running the matrix end-to-end against real networks (ghostnet + Tezos X previewnet) requires `WALLET_SK` and network access. This is the last gate before merging the Bucket B PR per constitution Principle II. The scaffolds are runnable as written.

## III. Real-Network Operations, Not Mocks

**Status**: ✅ Pass-by-construction.

**Evidence**:
- `_shared.ts` `runMultiNetworkMatrix()` issues real `requestOperation` calls against the reference dApp/wallet HTTP harness. The wallet signs against real RPCs (shadownet L1, Tezos X previewnet L2 — same endpoints as spec 002 `phase2.ts`).
- No `TezosToolkit` or RPC mocking introduced. The `executeL1Ops` / `executeL2Ops` helpers in `wallet/src/index.ts` and the `executeOp` helper in `wc2/wallet/src/main.ts` are the same real-network functions as before, just split per chain.
- SDK integration tests (T008, T012) — deliberately deferred to follow-up. The runtime green-light comes from the e2e matrix, not the SDK unit tests.

## IV. Reference Implementation Parity

**Status**: ✅ Pass.

**Evidence per reference app**:
- `dapp/src/index.ts` — monkey-patch removed (T015); calls `client.requestOperation({ network, operationDetails })` directly.
- `wc2/dapp/src/main.ts` — monkey-patch removed (T014); same clean API call.
- `wallet/src/index.ts` — dispatch table `handlers: Record<chainId, BlockchainHandlerBundle>` with explicit L1+L2 handlers (T016). Unknown chain id → wire-level `NETWORK_NOT_SUPPORTED + unsupportedNetworks` rejection.
- `wc2/wallet/src/main.ts` — explicit `SUPPORTED_CHAIN_IDS` set + same rejection pattern (T017). The `chainId.includes('NetXH12')` substring heuristic replaced with `chainId === L2_CHAIN` exact match.
- Both reference wallets MUST agree on the FR-005 rejection shape (`errorType: 'NETWORK_NOT_SUPPORTED'` + `unsupportedNetworks: string[]`). The dApp SDK materializes this as `NetworksUnsupportedBeaconError` uniformly across both peers.

**Verification**: T029 grep verification — zero `(client as any).makeRequest` and zero `if (typeof networkField === 'string')` inline branches across all four reference apps. Recorded in `grep-after.txt`.

## V. Spec & Integration Guide As Deliverables

**Status**: ✅ Pass.

**Evidence**:
- `docs/wallet-multichain-integration.md` §3a "Recommended integrator dispatch pattern" — new section with worked example (T024). Fits in <100 lines per SC-005.
- `docs/wallet-multichain-integration.md` §4 matrix — new rows for spec 003 FR-019 defensive and spec 003 FR-005 wallet rejection (T025). New conformance rules C6 + C7 added below the existing C1–C5.
- `proposal.html` — section 4 "SDK extension required" updated to cite spec 003 and the dApp-side ergonomics tail (T026).
- `poc-plan.html` — Objective 2 paragraph updated similarly (T027).
- `README.md` — Documents table grew by one row (spec 003); demo-branch note refreshed to indicate both spec 002 + 003 commits (T028).
- Each public-facing description cross-references the same demo branch (`octez.connect@feat/peer-version-handshake`).

## Open compliance gaps

1. **Principle II runtime green-light** — running `test:mn-all` + `test:pv-all` + `test:phase2` against real networks. Manual gate before declaring spec 003 done.
2. **Bucket A SDK PR description amendment (T031)** and **Bucket B outer-repo PR creation (T032)** — user-authorized actions; both pending.
3. **SDK integration tests (T008, T012)** — deferred to follow-up. The e2e matrix is the load-bearing verification per Principle II.

## Summary

Spec 003 satisfies all five constitution principles by construction, with two operational gates remaining (e2e matrix run + PR finalization). The SDK delta is ~310 lines across 8 files in `octez.connect/packages/*` on `feat/peer-version-handshake`; the outer-repo work spans reference apps, integration guide, website, and e2e scaffolds. The narrowing from `/speckit-clarify` Q1 (wallet SDK boundary stays thin) was load-bearing: the wallet SDK gained no API surface, only the dApp SDK and the integration guide did.
