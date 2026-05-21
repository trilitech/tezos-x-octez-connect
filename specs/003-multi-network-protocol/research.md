# Phase 0 Research: Multi-Network Protocol Support

**Feature**: 003-multi-network-protocol
**Status**: Complete (no NEEDS CLARIFICATION items remain)

## R1. Error class for FR-005 (wallet cannot serve all requested networks)

**Decision**: Add a new client-side error class `NetworksUnsupportedBeaconError` in `octez.connect-core/src/errors/`. Do **not** extend the existing `NetworkNotSupportedBeaconError`.

**Evidence**:

- `octez.connect/packages/octez.connect-core/src/errors/NetworkNotSupportedBeaconError.ts:13-19` — the existing class takes no constructor arguments and has a fixed message: `"The wallet does not support this network. Please select another one."` It is keyed on `BeaconErrorType.NETWORK_NOT_SUPPORTED` (a wire-level enum value).
- FR-005 requires the rejection to **name which networks** the wallet could not serve. This needs a structured `unsupportedNetworks: string[]` field on the error.
- The spec 002 precedent (`VersionUnsupportedBeaconError` at `octez.connect-core/src/errors/VersionUnsupportedBeaconError.ts`) is the better template: client-side-only class, not registered in `BeaconErrorType`, carries structured fields (`requiredMinimumVersion`, `walletServedVersion`).

**Shape (decided here, contracted in `contracts/networks-unsupported-error.md`)**:

```ts
class NetworksUnsupportedBeaconError extends BeaconError {
  readonly errorCode: 'NETWORKS_UNSUPPORTED'
  readonly requestedNetworks: string[]      // CAIP-2 chain ids the dApp asked for
  readonly unsupportedNetworks: string[]    // CAIP-2 chain ids the wallet cannot serve (subset of requestedNetworks)
  readonly message: string
}
```

Default message template: `"The wallet cannot serve all requested networks. Unsupported: ${unsupportedNetworks.join(', ')}."`

**Rationale**: Reusing `NetworkNotSupportedBeaconError` would require widening its constructor and changing its semantic (singular → plural), which is a backward-incompatible change to a wire-registered error type. Adding a new client-side class follows the spec 002 pattern, costs ~15 lines, and lets the existing class continue to mean "this single network is not supported" for its current use sites (which are mostly wallet-internal validation, not the cross-wire multi-network rejection).

**Alternatives considered**:
- *Reuse `NetworkNotSupportedBeaconError`* — rejected (above).
- *Use a generic `UnknownBeaconError` with a custom message* — rejected; loses the typed `unsupportedNetworks` field that dApps need for programmatic retry-with-subset behavior (per spec edge case "DApp may catch and retry with a subset").
- *Reuse `VersionUnsupportedBeaconError`* — rejected; semantically different (version vs. network capability).

## R2. Shape of `getAccountInfosFromPermissionResponse()` and where the multi-network response flows today

**Decision**: The blockchain method `getAccountInfosFromPermissionResponse()` is **already typed as returning `Promise<{ accountId, address, publicKey, network?, scopes }[]>`** — an array. The slice happens in `DAppClient.permissionRequest()` at `DAppClient.ts:1523, 1529, 1530, 1551`, not in the blockchain method. **However**, the Tezos blockchain implementation is currently a **stub**: it returns `[{ accountId: '', address: '', publicKey: '', network: undefined, scopes: [] }]` regardless of input. Multi-network data flows through `accountInfo.chainData = response.message.blockchainData` (DAppClient.ts:1533) — bypassing the blockchain abstraction entirely.

**Evidence**:

- `octez.connect/packages/octez.connect-types/src/types/beaconV3/PermissionRequest.ts:31-39` — `Blockchain.getAccountInfosFromPermissionResponse()` signature:
  ```ts
  getAccountInfosFromPermissionResponse(
    permissionResponse: PermissionResponseV3
  ): Promise<{
    accountId: string;
    address: string;
    publicKey: string;
    network?: Network;
    scopes: PermissionScope[];
  }[]>
  ```
- `octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts:47-63` — the Tezos implementation is a stub:
  ```ts
  async getAccountInfosFromPermissionResponse(
    _permissionResponse: PermissionResponseV3<'tezos'>
  ): Promise<...[]> {
    return [{
      accountId: '',
      address: '',
      publicKey: '',
      network: undefined,
      scopes: []
    }]
  }
  ```
  Note the underscore prefix on `_permissionResponse` — the parameter is deliberately unused.
- `octez.connect/packages/octez.connect-blockchain-tezos-sapling/src/blockchain.ts:43-58` — the **Sapling** implementation IS real and does the per-account mapping. It serves as the working reference for what the Tezos implementation should look like.
- `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts:1518-1537` — DAppClient calls the blockchain method, then takes only `partialAccountInfos[0]` regardless of how many records the method returned.

**Implication for the fix**: Two paths to choose between:

**Path A (preferred — fix at the blockchain abstraction)**: Implement `TezosBlockchain.getAccountInfosFromPermissionResponse()` properly. It should read `permissionResponse.blockchainData.accounts` (the CAIP-2-keyed map the wallet sends in v4) and return one `{ accountId, address, publicKey, network, scopes }` record per entry. For v3 single-network responses (no `accounts` map), it falls back to the singular wallet-supplied account.

**Path B (alternative — fix at DAppClient)**: Leave the blockchain stub; teach `DAppClient.permissionRequest()` to detect the multi-network response shape and bypass the blockchain method, building N AccountInfo records directly from `response.message.blockchainData.accounts`.

**Selected path: A.** Reasoning: (1) the blockchain abstraction was *designed* for this — its return type is already an array; the existing stub is dead code; (2) the Sapling blockchain has the worked example; (3) fix-at-the-layer-that-owns-it gives the cleanest reviewer experience; (4) the dApp-client loop change becomes a one-line slice removal.

**Rationale**: Path A keeps the responsibility boundary clean — blockchain code parses blockchain-specific response shapes; DAppClient does account lifecycle. Path B muddles them and would leave the Tezos blockchain stub as a latent bug. The "real value" framing from the user's clarification turns A's broader fix into a strict positive: we fix a stub that's currently dead code.

**Alternatives considered**:
- *Path B alone* — rejected (above).
- *Leave the stub and add a parallel multi-network parser to DAppClient* — rejected; produces two parsing paths that can drift.

## R3. `AccountManager.addAccount()` behavior with multiple records per peer

**Decision**: `AccountManager.addAccount()` keys storage on `accountIdentifier`. Adding N AccountInfo records with **distinct `accountIdentifier`s** results in N persisted records — exactly what we want. No schema or manager change required.

**Evidence**:

- `octez.connect/packages/octez.connect-core/src/managers/AccountManager.ts:25-30`:
  ```ts
  public async addAccount(accountInfo: AccountInfo): Promise<void> {
    return this.storageManager.addOne(
      accountInfo,
      (account) => account.accountIdentifier === accountInfo.accountIdentifier
    )
  }
  ```
  The `storageManager.addOne` upserts by `accountIdentifier`. Distinct identifiers → distinct records.
- `AccountManager.getAccounts()` at line 17 returns all stored records — the existing public API used by the reference dApps continues to work.
- The wallet's v4 multi-network response (`wallet/src/index.ts:294-300`) builds per-chain accounts with distinct public keys per chain. R2's Path A implementation will derive distinct `accountIdentifier`s from those distinct public keys (existing pattern: `accountIdentifier = hash(publicKey + chainId)` or similar — the Tezos blockchain implementation will follow the Sapling pattern at `octez.connect-blockchain-tezos-sapling/src/blockchain.ts:54` where `accountId = account.accountId`).

**Rationale**: The existing manager + storage layer naturally supports multi-record-per-session. The bug is only that DAppClient.permissionRequest() calls `addAccount()` exactly once with `partialAccountInfos[0]` — it never iterates. The fix is to loop.

**Risk to verify in implementation**: The legacy v3 path (single-network) returns N=1 from R2's fixed blockchain method. The loop must produce identical behavior to today's single `addAccount()` call. Spec 002 ghostnet tests + spec 003 multi-network tests both must remain green.

**Alternatives considered**:
- *New `addAccounts(...)` plural method* — rejected; the existing method handles N records perfectly when called in a loop.

## R4. Wire-level field shape for `operation_request.network`

**Decision**: The wire field `OperationRequestInput.network` already accepts both shapes today: legacy `Network` object (v2-era) **and** CAIP-2 string (v3+ enhancement, handled by the wallet at `wallet/src/index.ts:319-333` with explicit `typeof networkField === 'string'` discrimination). Spec 003 widens the **dApp-side input type** to allow CAIP-2 string directly (`network?: string` on the new `RequestOperationInput`) and the SDK stamps that string onto the outgoing message. The type of the outgoing wire field becomes `Network | string`. The wallet side requires no changes — it already handles both.

**Evidence**:

- `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts:1995-2000`:
  ```ts
  const request: OperationRequestInput = {
    type: BeaconMessageType.OperationRequest,
    network: activeAccount.network || this.network,   // Network object today
    operationDetails: input.operationDetails,
    sourceAddress: activeAccount.address || ''
  }
  ```
- Reference dApp `wc2/dapp/src/main.ts:339-342` monkey-patches `req.network = chainId` (a CAIP-2 string) directly on the outgoing message — i.e. the wire format already accepts a string here, and the wallet already handles it.
- Wallet handler `wallet/src/index.ts:319-333`:
  ```ts
  if (typeof networkField === 'string') {
    // v3: CAIP-2 string e.g. "tezos:NetXsqzbfFenSTS"
    chainId = networkField.startsWith('tezos:') ? networkField : `tezos:${networkField}`
    ...
  } else {
    // v2: network object { type, rpcUrl?, chainId? }
    ...
  }
  ```

**Outgoing field type widening (concrete)**: The `OperationRequestInput` interface (in `octez.connect-types`) needs its `network` field widened from `Network` to `Network | string`. This is byte-for-byte backward compatible: a `Network` object remains a `Network` object; the new `string` form is the v4 multi-network value.

**Rationale**: The wire format is already polymorphic and battle-tested by the reference dApps' own monkey-patch. Spec 003 lifts that pattern from "internal hack" to "first-class type". Constitution Principle I (backward compat) is satisfied because the `Network` object path continues to work unchanged.

**Alternatives considered**:
- *Add a new wire field (`operationNetwork: string`)* — rejected; would fragment the wire and break the existing wallet's discrimination logic.
- *Keep the dApp-side type as `Network` and force dApps to construct `{ type, name, rpcUrl, chainId }` objects* — rejected; the chainId is the only semantically required field, the rest are noise.

## R5. Canonical shape for the integrator dispatch pattern

**Decision**: The recommended pattern documented in the integration guide is a **dispatch table** — `Record<CAIP2ChainId, BlockchainHandlerBundle>` — with a small `dispatch(message, chainId)` helper that the integrator calls inside their own `connect(callback)` body. A handler bundle is an object with at least `{ onPermission, onOperation }` callbacks. Unknown chain ids invoke an optional `fallback` (or, if absent, throw a structured error).

**Evidence — pattern already exists informally**:

- `wallet/src/index.ts:98,107-110` — there is already a `networkRegistry: Record<string, string>` (chainId → rpcUrl) in the reference wallet. Lifting the same key shape to `Record<chainId, BlockchainHandlerBundle>` is a natural progression.
- Permission handling at `wallet/src/index.ts:294-300`:
  ```ts
  accounts[chainId] = { publicKey: ... }
  ```
  — already keyed on chainId, ready to be invoked per-chain via dispatch.
- Operation handling at `wallet/src/index.ts:319-333,354-401` — currently an `if (isL2)` inline branch on RPC URL substring; the documented pattern reorganizes this into `handlers[chainId].onOperation(req)`.

**Pattern sketch (informative, in the integration guide)**:

```ts
type BlockchainHandlerBundle = {
  onPermission: (req: PermissionRequest, network: NetworkDescriptor) => Promise<{ publicKey: string, ... }>
  onOperation: (req: OperationRequest) => Promise<{ transactionHash: string }>
  onError?: (err: unknown) => StructuredError
}

const handlers: Record<string /* CAIP-2 */, BlockchainHandlerBundle> = {
  'tezos:NetXsqzbfFenSTS': l1Handler,
  'tezos:NetXY2oPPzkxUW1': l2Handler,
}

// inside walletClient.connect(...)
const handler = handlers[chainId] ?? defaultHandler ?? (() => { throw new UnknownChainError(chainId) })
const result = await handler.onPermission(req, networkDescriptor)
```

The pattern is **not** SDK-enforced (per Clarifications Q1). The integration guide presents it as the recommended shape; integrators are free to implement equivalent logic differently as long as constitution Principles I and IV are met.

**Rationale**: A dispatch table is the lowest-ceremony pattern that scales. It matches the existing `networkRegistry` mental model; it's grep-able; it's testable in isolation per handler. Pattern-matching on chain id is the natural fit for a CAIP-2-keyed routing decision.

**Alternatives considered**:
- *Strategy class with subclass per chain* — rejected as over-engineered for a TS codebase; class hierarchies don't compose as cleanly as object literals for this use.
- *Switch/case in a single dispatch function* — rejected as harder to extend (every new chain modifies the same dispatch function).
- *Per-chain modules with side-effecting registration* — rejected; side-effecting `import` patterns make initialization order load-bearing, which is fragile.

## R6. FR-019 detection criteria — "v4 wallet response missing accounts[] fanout"

**Decision**: The dApp SDK invokes the FR-019 defensive path when **all four** of these conditions hold at permission-response time:

1. `peer.version >= '4'` (the wallet declared v4 capability per spec 002), AND
2. The dApp's request carried `networks.length > 1` (genuinely multi-network), AND
3. The response's `blockchainData` does not include an `accounts` map (or includes one with fewer entries than `request.networks.length`), AND
4. The dApp's `requiredMinimumVersion` (spec 002 SDK option) was set such that this multi-network response was expected — i.e. the dApp did not explicitly relax to v3.

**Evidence**:

- Spec 002 introduced `requiredMinimumVersion` (default = `BEACON_VERSION`). A v4 SDK with no override expects v4 multi-network responses for multi-network requests.
- The wallet's v4 multi-network response shape (`wallet/src/index.ts:294-305`) populates `accounts: Record<chainId, ...>` with one entry per requested network. A "v4 but no spec 003" wallet would not populate this map.
- The natural detection point is right after `getAccountInfosFromPermissionResponse()` returns. If R2's Path A returned fewer records than `request.networks.length`, that is the signal — no extra heuristic required.

**Resulting error**: Raise `NetworksUnsupportedBeaconError` (R1) with `unsupportedNetworks` populated from the set difference `request.networks - response.accounts.keys()`.

**Rationale**: Reusing R1's error class keeps the dApp's `catch` block uniform — one error type covers both "wallet rejected multi-network" (FR-005) and "wallet silently ignored multi-network" (FR-019). The four-condition gate prevents false positives in legitimate single-network flows.

**Risk to verify in implementation**: The `request.networks.length === 1` case must skip the defensive check (a single-network "request and got back single-network response" is the happy path, not a missing-fanout scenario).

**Alternatives considered**:
- *Treat any missing `accounts` map as a hard error regardless of `networks.length`* — rejected; would break v3 wallets responding to v4 dApps that didn't request multi-network.
- *Defer detection to a later operation call* — rejected; produces confusing errors at operation time when the real fault is at permission time.
