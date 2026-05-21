# Feature Specification: Multi-Network Protocol Support for Beacon v4

**Feature Branch**: `003-multi-network-protocol`

**Created**: 2026-05-20

**Status**: Draft

**Input**: User description: "the octez.connect sdk should be able to handle multiple network requests, for ex. (v4 permission_request networks[] semantics, v4 operation_request network CAIP-2, per-blockchain handler dispatch in the wallet interceptor, dApp-side requestOperation({ network }) API). currently at least two tezos networks should be able to connect via same dapp-wallet connection. I am not sure if its already supported or not. check if its already supported and if not devise all the required steps to support it."

---

## Background: Where Spec 002 Left Off

Spec 002 (`peer-version-handshake`) shipped the **negotiation contract**: BEACON_VERSION bumped to `'4'`, single-branch routing on `peer.version >= 4` in the wallet, `VersionUnsupportedBeaconError` on the dApp side, and a `requiredMinimumVersion` SDK option. It also added `RequestPermissionNetwork` as a public type and accepted `networks?: RequestPermissionNetwork[]` on `requestPermissions` (T028) — but it explicitly **deferred** the actual multi-network handling logic with this in-code marker:

> The multi-network field-handling delta is introduced in the per-blockchain permission/operation handlers that consume the interceptorCallback output (out of scope for this version-negotiation feature; tracked by the multi-network protocol spec).

This spec is "the multi-network protocol spec" that marker refers to. Today's state, verified by code inspection of `octez.connect@feat/peer-version-handshake` and the four reference apps:

| Surface | Today |
|---|---|
| `requestPermissions({ networks: [...] })` request plumbing | ✓ wired (spec 002 T028) |
| Wallet response with per-network accounts | ✓ produced by reference wallet (CAIP-2-keyed `accounts` map) |
| dApp SDK exposing per-network accounts to the caller | ✗ SDK extracts only `partialAccountInfos[0]`; remainder discarded |
| `requestOperation({ network })` API option | ✗ not present; reference dApps monkey-patch `(client as any).makeRequest` to inject the field |
| Per-blockchain handler dispatch in wallet SDK | ⚠ *deliberately not an SDK concern*: WalletClient exposes `connect(callback)` only; per-network branching is the integrator's responsibility today. Reference wallet has inline L1/L2 branching that the integration guide should formalize as the recommended pattern (see Clarifications Q1). |
| Multi-network session persistence | ✗ `AccountInfo` carries a single `network`; `PeerManager` cannot represent N networks per peer |
| `handleV4Message` interceptor | ⚠ exists, but delegates to v3 envelope plumbing — no per-blockchain dispatch yet |
| Multi-network end-to-end test green | ✓ phase2.ts proves L1+L2 in one handshake, but uses the SDK monkey-patch + reference-wallet ad-hoc routing |

Spec 003 closes those gaps so the SDK itself — not the reference apps' workarounds — supports a single dApp-wallet connection that covers two or more Tezos networks.

---

## Clarifications

### Session 2026-05-20

- Q: Should the wallet-SDK per-blockchain handler registry (originally proposed as US3 / FR-012–FR-016) stay in scope, given that the wallet SDK is currently a thin routing pass-through (`WalletClient.connect(callback)`) and per-blockchain dispatch is the integrator's responsibility by design? → A: B — Drop US3 entirely. Narrow the spec to dApp SDK ergonomics (US1 + US2 + reference cleanup). Document the recommended integrator-side dispatch pattern in the integration guide with the reference wallet as the worked example. Lifting dispatch into the wallet SDK is a separate design question worth its own future spec only if it ever becomes load-bearing for real wallet integrators.
- Q: When a wallet cannot serve every network in a `requestPermissions({ networks: [...] })` call, should it reject the whole request or partially fulfill? → A: A — Whole-request rejection with a structured error naming the unsupported networks. Mirrors spec 002's `VersionUnsupportedBeaconError` precedent; avoids half-fulfilled session ambiguity; dApp may catch and retry with a subset. FR-005 and edge case 1 already encode this; no spec edit needed beyond this Clarifications bullet.
- Q: What public API shape should the dApp SDK use to expose per-network accounts from a multi-network permission response? → A: A — Stop the `partialAccountInfos[0]` slice and persist all N records via the existing `getAccounts()` API. No new top-level method, no new account type. Each `AccountInfo` carries its own `network` field; dApps filter by `a.network.chainId === target`. Existing `setActiveAccount()` flow continues to pick one as active. FR-003 updated to commit to this shape.
- Decision: Delivery shape. The total SDK delta (~30–50 lines across 3–4 files in `octez.connect/packages/`) ships as **incremental commits on the existing open spec 002 PR** in `trilitech/octez.connect` — same `feat/peer-version-handshake` demo branch, no new demo branch. Reference dApps, reference wallets, integration guide, and website edits ship as a **separate new PR** in `tezos-x-octez-connect` off this `003-multi-network-protocol` branch. Rationale: the real ship is the SDK; the outer-repo artifacts are demonstration material whose reviewability is improved by separating them from SDK code review.

---

## User Scenarios & Testing

### User Story 1 — Multi-network session from a single permission request (Priority: P1) 🎯 MVP

A dApp developer building an application that spans Tezos L1 (e.g., ghostnet) and a Tezos L2 (e.g., Tezos X previewnet) wants to establish **one** wallet connection that covers both networks. Today the developer either maintains two parallel connections (poor UX, wallet shows two pairing prompts), or accepts that the SDK silently keeps only the first network's account from the wallet's response.

**Why this priority**: This is the headline ask. Without it, "multi-network" is purely a wire-level artifact with no usable dApp API surface.

**Independent Test**: A dApp calls `requestPermissions({ networks: [L1, L2] })` against an upgraded wallet. After the call resolves, the dApp can enumerate two networks in the session, each with its own served account address, both readable via a public SDK accessor. Verified by an e2e check that both addresses appear on-chain on their respective RPCs.

**Acceptance Scenarios**:

1. **Given** a v4 dApp paired with a v4 multi-network wallet, **when** the dApp requests permissions for `[L1-chainId, L2-chainId]`, **then** the wallet returns accounts for both, and the dApp SDK persists both as part of a single session — neither is discarded.
2. **Given** an established multi-network session, **when** the dApp asks the SDK for the set of networks present in the current session, **then** both networks are returned, each with its CAIP-2 chain id, served account, and any wallet-supplied metadata (name, suggested RPC URL).
3. **Given** an established multi-network session, **when** the SDK is reloaded (page refresh / process restart), **then** all networks are still present after rehydration from persistent storage — no loss across restart.
4. **Given** a v4 multi-network dApp and a legacy v3 wallet, **when** the dApp requests permissions for `[L1, L2]`, **then** the dApp surfaces `VersionUnsupportedBeaconError` (per spec 002) — no partial multi-network attempt against an incapable wallet.
5. **Given** a legacy v3 dApp and a v4 multi-network wallet, **when** the dApp requests permissions for its single network, **then** the wallet's v3 branch (spec 002) serves the legacy single-network response unchanged — no regression.

---

### User Story 2 — Send an operation to a specific network without monkey-patching (Priority: P1)

A dApp on a multi-network session needs to send an operation to a specific network. Today the SDK's `requestOperation` accepts no `network` argument, so dApps have to reach into private internals — `(client as any).makeRequest = …` — to stamp `req.network` on the outgoing message. That code lives in both `wc2/dapp/src/main.ts` and `dapp/src/index.ts` and is the project's own honest admission that the SDK API is incomplete.

**Why this priority**: Without a clean per-call network selector, multi-network sessions are effectively read-only. The dApp can know which networks exist but cannot target them.

**Independent Test**: A dApp on a multi-network session calls `client.requestOperation({ network: '<L2 chainId>', operationDetails: [...] })`. The wallet receives a wire message carrying that CAIP-2 identifier, signs and broadcasts on the L2 RPC, and the dApp receives back the L2 confirmation hash. Same flow works for L1 in the same session. Grep on `(client as any).makeRequest` in reference dApps returns zero results.

**Acceptance Scenarios**:

1. **Given** a multi-network session, **when** the dApp calls `requestOperation` with an explicit `network` argument carrying a CAIP-2 chain id that the session has permission for, **then** the outgoing `operation_request` carries that identifier in a field consumable by per-blockchain handlers, and the wallet routes to the correct network without any inline field-presence detection on the wallet side.
2. **Given** a multi-network session, **when** the dApp calls `requestOperation` without a network argument, **then** the SDK rejects the call with a structured error directing the caller to specify a network — no silent default.
3. **Given** a single-network session (legacy or v4-with-one-network), **when** the dApp calls `requestOperation` without a network argument, **then** the SDK uses the session's only network and behavior matches today.
4. **Given** a multi-network session, **when** the dApp calls `requestOperation` with a network argument the session does NOT have permission for, **then** the SDK raises a structured error before the request leaves the client — the wallet never sees the request.
5. **Given** a legacy v3 dApp, **when** it calls `requestOperation` against a v4 wallet, **then** the wallet's v3 branch handles it with the legacy `Network` object format — no regression.

---

### User Story 3 — Reference apps demonstrate the clean SDK API (Priority: P3)

The two reference dApps (`wc2/dapp`, `dapp/`) currently exercise multi-network through monkey-patches; the two reference wallets (`wc2/wallet`, `wallet/`) use inline chain-id branching. After this feature lands: (a) the monkey-patches are gone because the dApp SDK has a first-class `network` argument on `requestOperation`, and (b) the inline wallet branching is reorganized to match the **documented integrator dispatch pattern** in `docs/wallet-multichain-integration.md` (the integration guide formalizes the pattern; the wallet SDK is unchanged).

**Why this priority**: Closes the loop with constitution Principle IV (reference parity) and Principle V (spec & guide as deliverables). The dApp-side cleanup is the proof that the SDK API is usable without internal access. The wallet-side cleanup is the proof that the integrator pattern documented in the guide actually works end-to-end on two transports.

**Independent Test**: (a) Grep across all reference dApps for `(client as any).makeRequest` and `(client as any).network` — count must be zero. (b) The reference wallets' per-network logic must visibly follow the integration-guide pattern (a dispatch table or function-per-chain, not a chain of `if (chainId === ...)` inside the permission/operation handler); a code-review checklist item verifies this.

**Acceptance Scenarios**:

1. **Given** the reference dApps, **when** grepping for `(client as any)`, **then** zero hits remain that relate to operation-request or permission-request internals.
2. **Given** the reference wallets, **when** reading the permission-handler and operation-handler code paths, **then** the per-network logic is organized as a dispatch table (or equivalent pattern from the integration guide) rather than ad-hoc inline `if/else` chains.
3. **Given** the integration guide (`docs/wallet-multichain-integration.md`), **when** a wallet integrator follows it end-to-end, **then** the worked example uses only public SDK APIs, references the reference wallets as a copy-pasteable starting point, and cites the demo-branch commit id as the canonical reference implementation.

---

### Edge Cases

- **Wallet doesn't support one of the requested networks.** Default behavior: whole-request rejection with a structured error naming the unsupported network ids. (Rationale: matches spec 002's reject-pattern precedent; avoids ambiguous half-fulfilled sessions. May be revisited via `/speckit-clarify` if a stakeholder prefers partial fulfillment.)
- **DApp lists the same network twice in `networks[]`.** The SDK MUST dedupe before dispatching; the wallet MUST treat duplicates as one network.
- **Wallet user revokes one network mid-session but keeps the other.** The session degrades to single-network gracefully; the SDK exposes which networks remain. Operations targeting the revoked network raise a structured error.
- **DApp issues an `operation_request` with a `network` field not present in the current session.** The SDK rejects before the wire — the wallet does not see the request.
- **CAIP-2 string is malformed** (`"tezos:"` with empty reference, `"tezos:bad-format"`, wrong namespace like `"ethereum:..."`). The SDK rejects with a structured error at the API boundary; the wallet additionally rejects if the dApp bypasses the SDK check.
- **Network metadata mismatch** between request and persisted permission (e.g., `rpcUrl` in the operation_request differs from the one recorded at permission time). Wire-level network identity is the CAIP-2 chain id; metadata mismatches MUST NOT change routing — only the chain id does.
- **Spec 002 routed the message as `peer.version >= 4` but the v4 message is missing the multi-network fields.** This should not happen for v4 dApps using the SDK, but the wallet's v4 branch MUST be defensive and surface a structured error rather than silently coerce to a v3 shape.
- **An older v4 wallet (built against spec 002 but not 003) receives a multi-network request.** Per spec 002 rules the wallet is at its own max for the wire-level `peer.version` exchange, but it cannot serve `networks[]`-fanout. Resolution: the wallet either responds with the structured "unsupported networks" rejection from FR-005 (preferred — same code path) or, if it is unaware of multi-network semantics entirely, accepts only the first network and the dApp SDK detects the mismatch via a separate post-handshake validation (FR-019).
- **Operation timing across networks.** Two operations on different networks issued back-to-back may complete in either order. The SDK MUST NOT serialize them implicitly — each operation completes independently against its target network.

---

## Requirements

### Functional Requirements

#### Multi-network permission and session model

- **FR-001**: A dApp MUST be able to request permissions for one or more Tezos-family networks in a single `requestPermissions` call by passing an array of network descriptors that include each network's CAIP-2 chain id.
- **FR-002**: The SDK MUST persist the resulting session so that every network the wallet approved is accessible to the dApp after a successful handshake — no information loss between the wire response and the session record.
- **FR-003**: The SDK MUST persist every `partialAccountInfo` returned by the wallet as a distinct `AccountInfo` record accessible via the existing `getAccounts()` API — no new top-level accessor method, no new account type. Each `AccountInfo` MUST carry its own `network` field (CAIP-2 chain id plus any optional metadata returned by the wallet such as display name or RPC URL hint), and a dApp MUST be able to filter the returned set by `a.network.chainId` to find an account for a specific network. The existing `setActiveAccount()` flow continues to select one of these records as active. (Resolved by Clarifications Q3.)
- **FR-004**: The SDK MUST NOT silently discard accounts for networks beyond the first in the response — the current behavior (`partialAccountInfos[0]`) MUST be replaced.
- **FR-005**: When a dApp requests permissions and the wallet cannot serve all requested networks, the wallet MUST reject the whole request with a structured error that names which networks it could not serve. Partial fulfillment is NOT supported in v1.
- **FR-006**: Multi-network session state MUST survive SDK reload (page refresh / process restart) — persistence MUST cover the multi-network shape, not just the legacy single-network shape.

#### Per-call network selection on operations

- **FR-007**: The SDK's `requestOperation` API MUST accept an explicit `network` argument carrying a CAIP-2 chain id.
- **FR-008**: When the dApp calls `requestOperation` with an explicit network argument, the SDK MUST stamp the outgoing `operation_request` with that CAIP-2 identifier in a wire field consumable by per-blockchain handlers on the wallet side. The field MUST be a CAIP-2 string, distinct in shape from the legacy v2/v3 `Network` object.
- **FR-009**: The SDK MUST validate that the supplied network is one the current session has permission for; a mismatch MUST raise a structured error before the request leaves the SDK.
- **FR-010**: When the dApp calls `requestOperation` without a network argument and the session covers more than one network, the SDK MUST raise a structured error directing the caller to specify a network — no silent default selection.
- **FR-011**: When the dApp calls `requestOperation` without a network argument and the session covers exactly one network, the SDK MUST use that network — no regression for single-network dApps.

#### Wallet-side dispatch as integrator concern (no SDK changes)

- **FR-012**: The wallet SDK's public surface MUST NOT gain a per-blockchain handler registry. Per-blockchain dispatch remains the integrator's responsibility, dispatched within the integrator's own `connect(callback)` implementation. (Resolved by Clarifications Q1 — see Session 2026-05-20.)
- **FR-013**: The integration guide (`docs/wallet-multichain-integration.md`) MUST document a *recommended* integrator-side dispatch pattern for per-blockchain logic on the v4 branch. The reference wallets MUST follow this pattern and serve as the worked example.
- **FR-014**: The integrator pattern MUST NOT rely on field-presence detection of multi-network-era fields. The routing decision is `peer.version >= 4` (per spec 002), and within that branch the integrator dispatches on the CAIP-2 `network` / `networks[]` fields.

#### Reference parity (constitution Principle IV)

- **FR-015**: Reference dApps MUST exercise the multi-network API surface using public SDK calls only. Internal-access patterns like `(client as any).makeRequest = …`, used today to inject `operation_request.network`, MUST be removed.
- **FR-016**: Reference wallets MUST follow the documented integrator dispatch pattern (FR-013). Ad-hoc inline chain-id branching in the monolithic permission/operation handler MUST be replaced with the documented pattern's shape (e.g., a dispatch table keyed by CAIP-2 chain id, or a function-per-chain organization).

#### Backward compatibility (constitution Principle I)

- **FR-017**: A legacy v3 dApp connecting to a v4 multi-network wallet MUST receive the existing single-network response shape unchanged. Spec 002's wallet-side `peer.version`-routing already enforces this; this requirement MUST NOT be weakened by the dApp-side ergonomics changes in this spec.
- **FR-018**: A v4 multi-network dApp connecting to a legacy v3 wallet MUST surface `VersionUnsupportedBeaconError` (spec 002). Multi-network capability MUST NOT be silently degraded into a single-network result.

#### Defensive handling and forward extensibility

- **FR-019**: If a v4 wallet response is missing `accounts[]` fanout (e.g. an older v4 wallet built against spec 002 but not 003), the dApp SDK MUST detect the shape mismatch and either raise a structured error or invoke the FR-005 rejection path — silently treating an older v4 wallet as multi-network-capable is FORBIDDEN.
- **FR-020**: The CAIP-2 chain id namespace used by this feature MUST allow non-Tezos chains to be added in a future revision without breaking the wire shape. v1 scope is Tezos-family chain ids only (`tezos:<NetID>`).

### Key Entities

- **Network descriptor**: A CAIP-2 chain id plus optional human-readable name and optional RPC URL hint. Carried in `requestPermissions({ networks: [...] })` and persisted per session. The `RequestPermissionNetwork` type already exists from spec 002 T028 and is the canonical shape.
- **Multi-network session**: A single dApp-wallet pairing (one peer relationship, one peer.version, one transport, one Beacon session) that carries permission for one or more network descriptors, each with its own served account(s). Distinct from N parallel single-network sessions per pairing.
- **Operation request with explicit network**: A v4 `operation_request` carrying an explicit CAIP-2 `network` identifier that the integrator's dispatch code uses to select per-network logic. Wire-distinct from the legacy v3 `Network` object.
- **Integrator dispatch pattern (documented, not SDK-enforced)**: The recommended shape for how a wallet integrator routes v4 incoming messages by CAIP-2 chain id within their own `connect(callback)` implementation. Documented in `docs/wallet-multichain-integration.md`; demonstrated by the reference wallets. The wallet SDK itself remains a thin routing pass-through.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: A dApp developer can establish a single wallet connection covering two Tezos networks (one L1, one Tezos X L2) in under 5 minutes following the SDK quickstart, with no source-code modification to the SDK or reference wallet beyond their own dApp's call sites.
- **SC-002**: 100% of reference dApps and wallets exercise multi-network end-to-end without `(client as any).makeRequest`, `(client as any).network`, or equivalent internal-access patterns. Measured by a grep verification step in CI and in the polish-phase tasks.
- **SC-003**: The dispatch decision on incoming v4 `operation_request` messages on the wallet side is keyed exclusively on the CAIP-2 `network` field. Measured by zero inline field-presence checks on multi-network-era fields in the wallet SDK and the reference wallets (grep verification).
- **SC-004**: The existing single-network end-to-end flow (today's `phase2.ts`) continues to pass without modification beyond the call-site updates needed to consume the new API — zero regression on the legacy v3 branch or on single-network v4 usage.
- **SC-005**: The integration guide includes a worked example of the integrator dispatch pattern that fits in under 100 lines including comments — readable in one sitting and copy-pasteable as a starting point for new wallet integrators. The reference wallets visibly follow the same pattern.
- **SC-006**: The full negotiation matrix is green end-to-end against ghostnet (L1) and Tezos X previewnet (L2) for all three transports (P2P, WalletConnect v2, postMessage popup), across these cells: v4-multinetwork × v4-multinetwork, v4-multinetwork × v3-legacy (dApp gets `VersionUnsupportedBeaconError`), v3-legacy × v4-multinetwork (legacy single-network path), v4-multinetwork × v4-singlenetwork (FR-019 defensive path).
- **SC-007**: A dApp on a multi-network session can issue two operations targeted at two different networks within a single test run, and both confirm on-chain on their respective RPCs. End-to-end coverage on at least one transport.
- **SC-008**: The wallet integration guide and the public-facing website (`proposal.html`, `poc-plan.html`) describe the multi-network protocol delta, cite the spec 003 demo-branch commit id, and replace any remaining "tracked separately" references introduced by spec 002.

---

## Assumptions

- **Wallet SDK boundary stays thin (per Clarifications Q1).** Per-blockchain dispatch is the integrator's responsibility; the wallet SDK gains no handler registry in this spec. The integration guide formalizes the recommended pattern. Revisiting the SDK boundary is future work and would need its own spec.
- **Tezos-family chains only for v1.** This feature ships with Tezos L1 (mainnet/ghostnet/shadownet variants) and Tezos X L2 as the in-scope chain types. Adding non-Tezos chains (Ethereum, other L1s) is future work; the CAIP-2 string shape is the forward-compatible carrier.
- **Whole-request rejection over partial fulfillment.** If a wallet cannot serve every network in a `permission_request`, it rejects the whole request with a structured error naming the unsupported networks. This matches spec 002's reject-pattern precedent (`VersionUnsupportedBeaconError`) and avoids ambiguous session state. Open for revisit via `/speckit-clarify` if a stakeholder prefers partial fulfillment.
- **Single session, multiple networks.** A dApp-wallet connection is one Beacon session, one peer.version, one transport — and may carry permission for N networks. We are NOT introducing N parallel sessions per pairing. A user wanting strict isolation can create N pairings explicitly.
- **CAIP-2 string format on the wire.** All network identifiers on the wire are CAIP-2 strings of the form `tezos:<NetID>`. Other formats (numeric chain ids, RPC URLs alone, legacy `NetworkType` enums) are NOT accepted as routing keys in the v4 path. The reference wallet's existing CAIP-2 normalization (which tolerates a missing `tezos:` prefix) MAY remain as defensive input cleanup but the wire contract is CAIP-2.
- **No multi-network atomic operations.** A single `operation_request` targets a single network. Cross-network atomic operations are out of scope.
- **Spec 002 is settled.** The peer.version routing, the v4 BEACON_VERSION constant, `VersionUnsupportedBeaconError`, `InvalidRequiredMinimumVersionError`, the `requiredMinimumVersion` SDK option, the `RequestPermissionNetwork` type, and the `handleV4Message` dispatch stub are pre-existing. This spec consumes them; it does NOT re-spec them.
- **Octez.connect demo-branch lineage.** SDK changes ship as **incremental commits on the existing `feat/peer-version-handshake` branch** in the `octez.connect/` clone (gitignored from the outer repo) — the same branch backing the open spec 002 PR in `trilitech/octez.connect`. No new demo branch is created. The branch head moves forward from `82b6094b` (spec 002's last commit) to whatever HEAD spec 003 produces; the upstream PR description is amended in passing to note that the multi-network ergonomics tail is included. The outer repo's `003-multi-network-protocol` feature branch is the basis for a **separate new PR** in `tezos-x-octez-connect` containing reference-app, test, documentation, and website changes only.
- **Constitution principles carry forward.** All five principles from `.specify/memory/constitution.md` apply: backward compat (I), E2E per transport (II), real-network testing (III), reference parity (IV), and spec/guide as deliverables (V). E2E per transport is NON-NEGOTIABLE.

## Dependencies

- **Spec 002 (`002-peer-version-handshake`)**: Hard prerequisite. Without spec 002's peer.version routing, multi-network is undetectable on the wire. The `handleV4Message` stub, the `RequestPermissionNetwork` type, the `requiredMinimumVersion` option, and `VersionUnsupportedBeaconError` all come from 002. This spec extends them.
- **External RPC endpoints**: Tezos L1 ghostnet RPC and Tezos X L2 previewnet RPC — already in use by spec 002's e2e harness. No new external dependencies.
- **`trilitech/octez.connect` upstream**: Reference SDK source. The spec 002 PR (currently open) is the carrier for the spec 003 SDK delta as incremental commits on the same `feat/peer-version-handshake` branch — no new upstream PR is opened. Each public-facing document in this spec cites the updated demo-branch HEAD commit id once finalized.
- **`wallet/src/index.ts` test-config endpoint (spec 002 T046)**: The `POST /test-config` control surface that lets the test harness pin BEACON_VERSION on the wallet side. Reused here to scaffold the FR-021 defensive path (v4-multinet dApp vs. v4-but-singlenet wallet).
