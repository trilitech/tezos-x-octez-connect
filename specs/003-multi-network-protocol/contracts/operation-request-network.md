# Contract: `operation_request.network` — Per-Call Network Selection

**Feature**: 003-multi-network-protocol
**Status**: Normative
**Layer**: dApp-side SDK public API + wire format

## Scope of this contract

Add a first-class `network` argument to `requestOperation` so that dApps on a multi-network session can target a specific network per call **without** the `(client as any).makeRequest = …` monkey-patch the reference dApps carry today.

## Public dApp API (`RequestOperationInput`)

### Today

`octez.connect/packages/octez.connect-types/src/types/RequestOperationInput.ts`:

```ts
export interface RequestOperationInput {
  operationDetails: PartialTezosOperation[]
}
```

### After spec 003

```ts
export interface RequestOperationInput {
  operationDetails: PartialTezosOperation[]
  /**
   * Optional CAIP-2 chain id (e.g., 'tezos:NetXsqzbfFenSTS') targeting a specific
   * network in a multi-network session.
   *
   * - When omitted on a session with multiple networks: the SDK rejects with
   *   NetworksUnsupportedBeaconError directing the caller to specify a network.
   * - When omitted on a session with exactly one network: the SDK uses that
   *   network (backward compat with single-network usage).
   * - When provided: the SDK validates the value is one the current session
   *   has permission for, then stamps it onto the outgoing operation_request.
   */
  network?: string
}
```

### Rules

- **O1**: `network` is OPTIONAL. Omission is backward-compat with single-network dApps (FR-011).
- **O2**: When provided, the value MUST be a CAIP-2 string of the form `tezos:<NetID>`. Format is validated at the API boundary.
- **O3**: When provided, the value MUST match one of the chain ids present in the current session's `AccountInfo` records (i.e. some `getAccounts().some(a => a.network.chainId === input.network)` MUST hold true). Mismatch raises `NetworksUnsupportedBeaconError` with `unsupportedNetworks: [input.network]` before the request leaves the SDK (FR-009).
- **O4**: When omitted on a multi-network session (`getAccounts().filter(...).length > 1` distinct chain ids), the SDK raises a structured error (`NetworksUnsupportedBeaconError` with an "ambiguous — specify network" message) — no silent default selection (FR-010).
- **O5**: When omitted on a single-network session, the SDK uses the session's only network. Behavior is byte-for-byte identical to today (FR-011).
- **O6**: A legacy v3 dApp call to `requestOperation` (no `network` argument because the type didn't have it) continues to work against any wallet. The new optional field is additive (constitution Principle I).

## SDK wire-build (`DAppClient.requestOperation`)

### Today

`octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts:1995-2000`:

```ts
const request: OperationRequestInput = {
  type: BeaconMessageType.OperationRequest,
  network: activeAccount.network || this.network,
  operationDetails: input.operationDetails,
  sourceAddress: activeAccount.address || ''
}
```

### After spec 003

```ts
// Resolve the target chain id with the rules above:
const resolvedChainId = resolveTargetChainId(input.network, this.accountManager)
//   ^ throws NetworksUnsupportedBeaconError on FR-009 / FR-010 violations

// Stamp the outgoing wire field with the CAIP-2 string form:
const request: OperationRequestInput = {
  type: BeaconMessageType.OperationRequest,
  network: resolvedChainId ?? (activeAccount.network || this.network),
  //       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //       String (CAIP-2) form when input.network was set; legacy Network
  //       object form otherwise (single-network / single-account session).
  operationDetails: input.operationDetails,
  sourceAddress: activeAccount.address || ''
}
```

## Wire format (`OperationRequestInput.network`)

### Today

`OperationRequestInput.network: Network` — a typed object `{ type, name?, rpcUrl?, chainId? }`. Tolerates string form informally (the wallet handler at `wallet/src/index.ts:319-333` discriminates with `typeof networkField === 'string'`).

### After spec 003

`OperationRequestInput.network: Network | string` — formally widened. The string form carries a CAIP-2 chain id.

### Rules

- **W1**: A `string` value MUST be a CAIP-2 chain id. The wallet's existing discrimination logic at `wallet/src/index.ts:319-333` handles this case without changes (see [research.md](./research.md) R4).
- **W2**: A `Network` object value MUST continue to be handled byte-for-byte as today. Legacy v3 dApps and single-network v4 dApps continue to emit this form.
- **W3 (no wallet-side change)**: The wallet SDK requires NO changes. The discrimination is already in place from spec 002's existing handler.

## Reference-app cleanup (FR-015)

After spec 003 lands, both reference dApps remove their monkey-patches:

### `wc2/dapp/src/main.ts` (today, lines 335-343)

```ts
// REMOVE THIS BLOCK:
const orig = (client as any).makeRequest.bind(client)
;(client as any).makeRequest = function (req: any, ...args: any[]) {
  if (req?.type === 'operation_request') req.network = chainId
  return orig(req, ...args)
}
```

### After spec 003

```ts
// REPLACED BY (at the requestOperation call site):
await client.requestOperation({
  network: chainId,
  operationDetails: [...]
})
```

### `dapp/src/index.ts`

Same removal pattern. Grep verification post-cleanup: zero matches for `(client as any).makeRequest` across the outer repo.

## Backward-compatibility matrix

| dApp call | Session state | Outgoing wire | Wallet behavior |
|-----------|---------------|---------------|-----------------|
| `requestOperation({ operationDetails })` — no `network` | single-network (legacy v3 or v4-with-one-network) | `network: <Network object>` | Today's path unchanged. |
| `requestOperation({ operationDetails })` — no `network` | multi-network | SDK rejects with `NetworksUnsupportedBeaconError` ("ambiguous — specify network"). Wallet never sees the request. | n/a |
| `requestOperation({ network: 'tezos:L1', operationDetails })` | session has L1 | `network: 'tezos:L1'` (string) | Wallet's string-discrimination branch routes to L1 RPC. |
| `requestOperation({ network: 'tezos:L2', operationDetails })` | session has L2 | `network: 'tezos:L2'` (string) | Wallet's string-discrimination branch routes to L2 RPC. |
| `requestOperation({ network: 'tezos:L3', operationDetails })` | session has L1+L2 but NOT L3 | SDK rejects with `NetworksUnsupportedBeaconError`. | n/a (request never sent) |
| `requestOperation({ network: 'ethereum:1', operationDetails })` | any | SDK rejects with malformed-CAIP-2 / unsupported-namespace error (out of v1 scope per FR-020). | n/a |
