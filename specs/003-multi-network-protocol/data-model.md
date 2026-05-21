# Data Model: Multi-Network Protocol Support

**Feature**: 003-multi-network-protocol

## Overview

This feature introduces **no new wire-level entity** and **no new persistence schema**. All entities below are either (a) existing types being correctly populated (where today they are stubbed or sliced), (b) one existing type widened by one optional field, or (c) one new client-side error class.

Spec 002 already shipped the `RequestPermissionNetwork` input type and the `networks[]` field on `permission_request`. Spec 003 consumes those without re-spec'ing them.

## Entities

### `AccountInfo` (existing — used multi-instance per session)

- **Owner**: dApp-side SDK persistence (`AccountManager` in `octez.connect-core`).
- **Type definition**: `octez.connect/packages/octez.connect-types/src/types/AccountInfo.ts` — unchanged.
- **Shape today** (relevant fields):
  ```ts
  interface AccountInfo extends PermissionEntity {
    accountIdentifier: AccountIdentifier   // primary key
    senderId: string
    publicKey?: string
    walletType: 'implicit' | 'abstracted_account'
    // ...
    // PermissionEntity contributes:
    network: Network                       // per-account network
    scopes: PermissionScope[]
    address: string
  }
  ```
- **Spec 003 change**: zero schema change. The relationship changes: where today there is **one `AccountInfo` per peer/session**, spec 003 enables **N `AccountInfo` records per peer/session**, each addressed by a distinct `accountIdentifier` derived from the (publicKey, chainId) pair.
- **Cardinality (before/after)**:
  - Before spec 003: 1 `AccountInfo` per `requestPermissions()` call (the `[0]` slice).
  - After spec 003: 1..N records per call, one per CAIP-2 chain id in the wallet's response.
- **Identity & uniqueness**: `accountIdentifier` is the primary key (per `AccountManager.addAccount()` at `octez.connect-core/src/managers/AccountManager.ts:25-30`). The wallet's per-chain response (`wallet/src/index.ts:294-300`) produces distinct public keys per chain id, so derived identifiers are naturally distinct.
- **Lifecycle**:
  - Created during `DAppClient.permissionRequest()` — one per entry returned by `blockchain.getAccountInfosFromPermissionResponse()`.
  - Read by `DAppClient.getAccounts()`, `DAppClient.getActiveAccount()`, `setActiveAccount(accountIdentifier)`.
  - Updated never (each new permission flow recreates).
  - Removed by `removeAccount(accountIdentifier)` / `removeAllAccounts()`.

### `RequestOperationInput` (extended — one new optional field)

- **Owner**: dApp-side SDK public API.
- **Type definition**: `octez.connect/packages/octez.connect-types/src/types/RequestOperationInput.ts`.
- **Shape today** (8 lines, unchanged since pre-002):
  ```ts
  export interface RequestOperationInput {
    operationDetails: PartialTezosOperation[]
  }
  ```
- **Shape after spec 003**:
  ```ts
  export interface RequestOperationInput {
    operationDetails: PartialTezosOperation[]
    /**
     * Optional CAIP-2 chain id (e.g., 'tezos:NetXsqzbfFenSTS') targeting a specific
     * network in a multi-network session. When omitted on a multi-network session,
     * the SDK rejects with a structured error. When omitted on a single-network
     * session, the SDK uses the session's only network (backward compat).
     */
    network?: string
  }
  ```
- **Validation rules**:
  - If provided, MUST be a CAIP-2 string of the form `tezos:<NetID>`. Format is checked at the API boundary.
  - If provided, MUST match one of the chain ids present in the current session's `AccountInfo` records (FR-009). Mismatch raises a structured error before the request leaves the SDK.
  - If omitted on a session with multiple networks, the SDK raises a structured error directing the caller to specify (FR-010).
  - If omitted on a session with exactly one network, the SDK uses that network (FR-011).

### `OperationRequest` wire shape (existing field widened)

- **Owner**: Wire format (Beacon v3 payload).
- **Type definition (current)**: `OperationRequestInput.network: Network` — a typed object `{ type, name?, rpcUrl?, chainId? }`.
- **Type definition (after spec 003)**: `OperationRequestInput.network: Network | string` — widened to also accept a CAIP-2 string.
- **Reasoning**: The wallet handler (`wallet/src/index.ts:319-333`) already discriminates on `typeof networkField === 'string'`; the wire format has tolerated both shapes informally since the reference dApps' monkey-patch was introduced. Spec 003 lifts the string form to a first-class typed alternative. (See [research.md](./research.md) R4.)
- **Backward compat**: `Network` object form continues to work byte-for-byte. New dApps emit the string form; legacy wallets that only handle the object form continue to receive it from legacy dApps (constitution Principle I).

### `TezosBlockchain.getAccountInfosFromPermissionResponse()` (existing stub → real implementation)

- **Owner**: `octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts:47-63`.
- **Current state**: A **stub** returning `[{ accountId: '', address: '', publicKey: '', network: undefined, scopes: [] }]` regardless of input. (See [research.md](./research.md) R2.)
- **After spec 003**: Reads `permissionResponse.blockchainData.accounts` (the CAIP-2-keyed map the wallet sends in v4) and returns one record per entry. For v3 single-network responses (no `accounts` map), falls back to the single-network shape derivable from existing `blockchainData` fields.
- **Reference implementation**: The Sapling blockchain's existing real implementation at `octez.connect-blockchain-tezos-sapling/src/blockchain.ts:43-58` serves as the working template.
- **Shape of returned records** (unchanged from the existing interface signature):
  ```ts
  Promise<{
    accountId: string;
    address: string;
    publicKey: string;
    network?: Network;
    scopes: PermissionScope[];
  }[]>
  ```

### `NetworksUnsupportedBeaconError` (new — client-side only)

- **Owner**: dApp-side SDK error class. Never on the wire.
- **File**: `octez.connect/packages/octez.connect-core/src/errors/NetworksUnsupportedBeaconError.ts` (new).
- **Template**: Follows spec 002's `VersionUnsupportedBeaconError` pattern (same file directory, same client-side-only role, structured fields).
- **Shape**:
  ```ts
  class NetworksUnsupportedBeaconError extends BeaconError {
    readonly errorCode: 'NETWORKS_UNSUPPORTED'
    readonly requestedNetworks: string[]
    readonly unsupportedNetworks: string[]
    readonly message: string
  }
  ```
- **When raised** (one of two paths):
  1. **FR-005**: Wallet returned a permission response that names networks it cannot serve. `unsupportedNetworks` carries those names; `requestedNetworks` is the dApp's original request.
  2. **FR-019**: Wallet returned a v4 response missing the `accounts[]` fanout for a multi-network request (see [research.md](./research.md) R6). `unsupportedNetworks` is computed as the set difference `request.networks − response.accounts.keys()`.
- **NOT registered in** `BeaconErrorType`. Never crosses the wire; discrimination is via `instanceof` and the `errorCode` literal.
- See [contracts/networks-unsupported-error.md](./contracts/networks-unsupported-error.md) for the normative contract.

### `RequestPermissionNetwork` (existing — spec 002 T028)

- **Owner**: dApp-side SDK public API + wire format.
- **Type definition**: `octez.connect/packages/octez.connect-types/src/types/RequestPermissionInput.ts`. Unchanged in spec 003.
- **Shape**:
  ```ts
  interface RequestPermissionNetwork {
    chainId: string         // CAIP-2 — required
    name?: string           // display hint
    rpcUrl?: string         // RPC URL hint
  }
  ```
- **Role in spec 003**: Already the entry shape on `requestPermissions({ networks: [...] })`. Spec 003 consumes it unchanged; the wire-level `permission_request.networks[]` is also unchanged.

## Integrator Dispatch Pattern (informative, not SDK-enforced)

**Status**: Documentary only. This is the **recommended shape** for the integration guide's worked example (FR-013), not an SDK type. The wallet SDK exposes no such type; integrators may implement equivalent logic differently as long as constitution Principles I and IV are met.

**Pattern**:

```ts
// In the wallet integrator's own code, inside their walletClient.connect(callback) body:

type BlockchainHandlerBundle = {
  onPermission: (req: PermissionRequest, network: RequestPermissionNetwork) =>
    Promise<{ publicKey: string }>
  onOperation: (req: OperationRequest) =>
    Promise<{ transactionHash: string }>
  onError?: (err: unknown) => StructuredError
}

const handlers: Record<string /* CAIP-2 chain id */, BlockchainHandlerBundle> = {
  'tezos:NetXsqzbfFenSTS': tezosL1Handler,
  'tezos:NetXY2oPPzkxUW1': tezosXL2Handler,
}

function dispatch(message: BeaconMessage): Promise<unknown> {
  const chainId = extractChainId(message) // CAIP-2 string from the request
  const handler = handlers[chainId] ?? fallbackHandler
  if (!handler) throw new NetworksUnsupportedBeaconError(...)
  return invokeFor(message.type, handler, message)
}
```

- **Reference implementation**: The reference wallets `wallet/src/index.ts` and `wc2/wallet/src/main.ts` will be refactored to use exactly this shape in Bucket B.
- **Documentation home**: `docs/wallet-multichain-integration.md` §X (new section) — the worked example fits in <100 lines per SC-005.
- **Why not SDK-enforced**: Per Clarifications Q1, the wallet SDK boundary stays thin; per-blockchain dispatch is the integrator's responsibility.

## Relationships

```text
┌──────────────────┐  1   ┌───────────────────────┐
│ DAppClient       │──────│ Peer (PeerManager)    │
└──────────────────┘      └───────────────────────┘
        │  1                       │  1
        │                          │
        │  N (after spec 003)      │  N (already supported)
        ↓                          ↓
┌──────────────────┐          ┌───────────────────┐
│ AccountInfo      │          │ AccountInfo       │
│  network: L1     │          │  same instances   │
│  accountIdent.…  │          │  reachable via    │
└──────────────────┘          │  AccountManager   │
        ↑                     │  .getAccounts()   │
        │ peer ←── pair ──→ wallet                │
┌──────────────────┐          └───────────────────┘
│ AccountInfo      │
│  network: L2     │
│  accountIdent.…  │
└──────────────────┘
```

A single dApp-wallet pair (one `Peer` record, one `peer.version` value, one transport) is associated with N `AccountInfo` records — one per CAIP-2 chain id in the multi-network permission response. The "active account" is one of those N, selected via `setActiveAccount(accountIdentifier)`.

## Data flow on `requestPermissions({ networks: [L1, L2] })`

1. **dApp side**: Build `RequestPermissionInput` with `networks: [L1, L2]` (spec 002 T028). Send.
2. **Wire**: `permission_request` carries `networks: [{ chainId: 'tezos:NetXsqzbfFenSTS' }, { chainId: 'tezos:NetXY2oPPzkxUW1' }]` (spec 002).
3. **Wallet side**: Invokes integrator's per-network handlers (R5 pattern). Builds `accounts: Record<chainId, { publicKey }>` (existing reference code).
4. **Wire**: `permission_response` carries `blockchainData.accounts = { 'tezos:NetXsqzbfFenSTS': {...}, 'tezos:NetXY2oPPzkxUW1': {...} }`.
5. **dApp SDK ingress** (`DAppClient.permissionRequest()`):
   - `blockchain.getAccountInfosFromPermissionResponse(response.message)` → `[{ accountId, address, publicKey, network, scopes }, { ... }]` (N=2 after R2 Path A fix).
   - **Spec 003 change**: loop over the array, create one `AccountInfo` per entry, call `accountManager.addAccount(...)` for each.
   - First one becomes the active account (via `setActiveAccount`), or all if a "switch" UI is implemented.
6. **dApp visibility**: `client.getAccounts()` returns N records, filterable by `a.network.chainId === target`.

## Data flow on `requestOperation({ network: 'tezos:NetXY2oPPzkxUW1', operationDetails })`

1. **dApp side**: Call `client.requestOperation({ network, operationDetails })`.
2. **SDK validation**: Confirm `network` is present in current session's `AccountInfo` records. If not, raise `NetworksUnsupportedBeaconError` (FR-009).
3. **Outgoing message**: `OperationRequestInput.network = 'tezos:NetXY2oPPzkxUW1'` (CAIP-2 string form, R4 widening).
4. **Wallet side**: Existing handler at `wallet/src/index.ts:319-333` discriminates `typeof networkField === 'string'` and routes to L2 RPC. After Bucket B refactor: dispatches via the R5 pattern's handler table.
5. **Confirmation**: L2 RPC returns operation hash; wallet sends `operation_response`; dApp resolves.
