# Contract: Multi-Network Permission Request & Response

**Feature**: 003-multi-network-protocol
**Status**: Normative
**Layer**: Wire format (Beacon v3 payload on `peer.version >= '4'`) + dApp-side SDK ingress

## Scope of this contract

Spec 002 T028 plumbed `networks?: RequestPermissionNetwork[]` into the outgoing `permission_request`. **This contract formalizes the response shape** and the dApp SDK's correct handling of it — fixing the `partialAccountInfos[0]` slice that today drops everything except the first network.

## Request side (unchanged from spec 002 T028)

```ts
// Public dApp API
client.requestPermissions({
  networks: [
    { chainId: 'tezos:NetXsqzbfFenSTS', name: 'Ghostnet' },
    { chainId: 'tezos:NetXY2oPPzkxUW1', name: 'Tezos X Previewnet' }
  ]
})

// Wire-level (on the v4 branch)
{
  type: 'permission_request',
  blockchainData: {
    appMetadata: { ... },
    scopes: [...],
    networks: [
      { chainId: 'tezos:NetXsqzbfFenSTS', ... },
      { chainId: 'tezos:NetXY2oPPzkxUW1', ... }
    ]
  }
}
```

**Rules** (carried over from spec 002):
- `networks[]` is OPTIONAL. Omission MUST mean "single-network — use the dApp's existing default network".
- `chainId` MUST be CAIP-2 (`tezos:<NetID>`). Other namespaces (`ethereum:`, etc.) are NOT in scope for v1.
- Duplicates in `networks[]` MUST be deduped by the SDK before the wire send.

## Response side (formalized here)

### Wire shape (wallet output)

```ts
{
  type: 'permission_response',
  blockchainData: {
    appMetadata: { ... },
    scopes: [...],
    accounts: {                         // CAIP-2-keyed map. REQUIRED for multi-network responses.
      'tezos:NetXsqzbfFenSTS': { publicKey: '...', address: 'tz1...' },
      'tezos:NetXY2oPPzkxUW1': { publicKey: '...', address: 'tz1...' }
    }
  }
}
```

**Rules**:

- **C1 (REQUIRED for multi-network)**: When the request carried `networks.length >= 2`, the response MUST carry `accounts` as a CAIP-2-keyed map with one entry per requested network the wallet serves.
- **C2 (OPTIONAL for single-network)**: When the request carried `networks.length <= 1` (including omitted), the response MAY include `accounts` or MAY use the legacy single-network shape. dApp SDK ingress (below) handles either.
- **C3 (subset rule)**: The set of keys in `accounts` MUST be a subset of the requested `chainId` set. The wallet MUST NOT add networks the dApp did not ask for. (See FR-005 / `contracts/networks-unsupported-error.md` for the rejection path when the wallet can't serve all requested networks.)
- **C4 (per-account fields)**: Each value in `accounts` MUST carry `publicKey` and `address`. It MAY carry additional metadata (scopes per chain, etc.) — the dApp SDK ingress is liberal in what it accepts.
- **C5 (legacy v3 response unchanged)**: A `peer.version = '3'` wallet does NOT populate `accounts` and continues to use the legacy single-network response fields exclusively. The wallet-side `peer.version`-routing from spec 002 already enforces this.

### dApp SDK ingress (`DAppClient.permissionRequest()`)

```ts
// pseudo-code; see quickstart.md Step 1 for the actual diff
const partialAccountInfos = await blockchain.getAccountInfosFromPermissionResponse(response.message)
//                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                       After spec 003, this is the REAL parser (research.md R2 Path A)
//                                       returning N records from blockchainData.accounts.

for (const partial of partialAccountInfos) {
  const accountInfo = {
    accountIdentifier: partial.accountId,
    senderId: response.senderId,
    origin: { type: connectionInfo.origin, id: connectionInfo.id },
    address: partial.address,
    publicKey: partial.publicKey,
    scopes: partial.scopes,
    network: partial.network,
    connectedAt: Date.now(),
    chainData: response.message.blockchainData
  }
  await this.accountManager.addAccount(accountInfo)
}
await this.setActiveAccount(partialAccountInfos[0] ? toAccountInfo(partialAccountInfos[0]) : undefined)
```

**Rules**:

- **C6**: The SDK MUST call `addAccount(...)` once per entry in `partialAccountInfos`. The `[0]` slice (current behavior at `DAppClient.ts:1523,1529,1530,1551`) MUST be removed.
- **C7**: The first record becomes the active account by default. (Future enhancement: a `defaultNetwork` option in `RequestPermissionInput` could let the dApp pick — out of scope for v1.)
- **C8 (FR-019 defensive)**: If `request.networks.length >= 2` and the wallet's response carries `accounts` with fewer entries than requested (or no `accounts` map at all), the SDK MUST raise `NetworksUnsupportedBeaconError` (see [networks-unsupported-error.md](./networks-unsupported-error.md)) with `unsupportedNetworks` populated from the set difference. No partial session is created.
- **C9 (single-network passthrough)**: If `request.networks.length <= 1` and the response uses the legacy single-network shape, the SDK MUST emit exactly one `AccountInfo` — identical to today's behavior. Zero regression for v3 dApps and single-network v4 dApps.
- **C10 (identifier uniqueness)**: The blockchain implementation's `getAccountInfosFromPermissionResponse` MUST derive distinct `accountId` values for each entry. The reference implementation derives from `(publicKey, chainId)` — the wallet's distinct per-chain public keys naturally produce distinct identifiers.

## Backward-compatibility matrix

| dApp version | Wallet version | Request shape | Response shape | dApp SDK behavior |
|--------------|----------------|---------------|----------------|-------------------|
| v3 (legacy) | v3 (legacy) | no `networks[]` | legacy single | One `AccountInfo`. Unchanged. |
| v3 (legacy) | v4 multi-network | no `networks[]` | legacy single (per spec 002 v3 branch) | One `AccountInfo`. Unchanged. |
| v4 single-network | v4 multi-network | `networks.length === 1` | `accounts` with one entry, or legacy single | One `AccountInfo`. C9 applies. |
| v4 single-network | v4 single-network | `networks.length === 1` | `accounts` with one entry, or legacy single | One `AccountInfo`. C9 applies. |
| v4 multi-network | v4 multi-network | `networks.length >= 2` | `accounts` with all entries | N `AccountInfo`s. C6. **The headline path.** |
| v4 multi-network | v4 single-network | `networks.length >= 2` | `accounts` with fewer entries (or none) | `NetworksUnsupportedBeaconError` raised. C8. |
| v4 multi-network | v3 (legacy) | `networks.length >= 2` | wire-level `version_unsupported` from dApp SDK | Caught by spec 002 `VersionUnsupportedBeaconError` — request never sent. |
