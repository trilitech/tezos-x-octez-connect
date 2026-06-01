# Contract: `NetworksUnsupportedBeaconError`

**Feature**: 003-multi-network-protocol
**Status**: Normative
**Layer**: dApp-side SDK only (never on the wire)

## Class

- **Path**: `octez.connect/packages/octez.connect-core/src/errors/NetworksUnsupportedBeaconError.ts` (new file).
- **Extends**: `BeaconError` — same base class as `UnknownBeaconError`, `AbortedBeaconError`, `VersionUnsupportedBeaconError`.
- **NOT registered in** `BeaconErrorType`. The error never crosses the wire; therefore it has no `errorType` enum value. Discrimination is via `instanceof` and the `errorCode` literal — same pattern as `VersionUnsupportedBeaconError` from spec 002.

## Shape

```ts
class NetworksUnsupportedBeaconError extends BeaconError {
  readonly errorCode: 'NETWORKS_UNSUPPORTED'
  readonly requestedNetworks: string[]      // CAIP-2 chain ids the dApp asked for
  readonly unsupportedNetworks: string[]    // CAIP-2 chain ids the wallet cannot serve (subset of requestedNetworks)
  readonly message: string
}
```

### Field semantics

| Field | Type | Definition |
|-------|------|------------|
| `errorCode` | string literal `'NETWORKS_UNSUPPORTED'` | Stable identifier for programmatic handling. Never changes. |
| `requestedNetworks` | `string[]` | The CAIP-2 chain ids the dApp passed to `requestPermissions({ networks: [...] })` (FR-005 path) or to `requestOperation({ network })` (FR-009 path). Order preserved from the original call. |
| `unsupportedNetworks` | `string[]` | The subset of `requestedNetworks` that the wallet cannot serve (FR-005) or that is not in the current session (FR-009). MUST be a subset of `requestedNetworks` and non-empty (an empty set would not be an error condition). |
| `message` | string | Human-readable, stable enough for direct UI display. Default templates below depending on path. |

### Default message templates

- **FR-005 path** (empty served subset — F1): `"The wallet cannot serve any of the requested networks: ${unsupportedNetworks.join(', ')}."` (A non-empty subset is partial fulfillment and does not raise — see "When NOT raised".)
- **FR-009 path** (operation targeting an unauthorized network): `"The requested network ${unsupportedNetworks[0]} is not in the current session. Available: ${authorizedNetworks.join(', ')}."`
- **FR-010 path** (operation with no network argument on a multi-network session): `"Multiple networks are available in this session (${authorizedNetworks.join(', ')}). Specify a network argument on requestOperation."` In this path, `requestedNetworks` is empty and `unsupportedNetworks` is empty; the caller distinguishes by checking `requestedNetworks.length === 0`.
- **FR-019 path** (v4 wallet returns no accounts[] fanout at all): `"The wallet's response carries no per-network accounts for the ${requestedNetworks.length} requested networks. The wallet declares v4 but may not support spec 003 multi-network fanout."`

## When raised

The dApp-side SDK MUST raise this error in any of these conditions:

### F1 — Wallet served none of the requested networks (FR-005, revised 2026-06-01)

1. A `requestPermissions({ networks: [...] })` call has been sent, AND
2. The wallet's response carries an **empty** served subset — `accounts` is present but has zero entries that match the requested networks (the wallet understands fanout but could serve none of them).

In this case:
- `requestedNetworks` = the dApp's original request list
- `unsupportedNetworks` = the full requested set (nothing could be served)
- No `AccountInfo` records are added; no session is created.

> **Not F1: partial fulfillment.** If the wallet serves a *non-empty* subset (some but not all requested networks), this is valid partial fulfillment per FR-005 — the SDK persists the served accounts and does NOT raise. The dApp inspects `getAccounts()` (and any advisory `unsupportedNetworks` on the response) and decides whether the subset is enough. The decision is the dApp's, not the wallet's.

### F2 — Operation targets a network not in session (FR-009)

1. `requestOperation({ network })` was called, AND
2. `network` is NOT one of the chain ids in the current session's `AccountInfo` records.

In this case:
- `requestedNetworks` = `[input.network]`
- `unsupportedNetworks` = `[input.network]` (it's not in the session)
- The wire request is NOT sent; the wallet never sees it.

### F3 — Operation with no network on a multi-network session (FR-010)

1. `requestOperation({ operationDetails })` called without a `network` argument, AND
2. The current session has more than one distinct chain id in its `AccountInfo` records.

In this case:
- `requestedNetworks` = `[]` (none requested — caller didn't pick)
- `unsupportedNetworks` = `[]`
- The caller distinguishes this path by checking `requestedNetworks.length === 0` plus the message text.

### F4 — Defensive: v4 wallet response carries no `accounts[]` fanout at all (FR-019)

1. `requestPermissions({ networks: [...] })` with `networks.length >= 2` was sent, AND
2. `peer.version >= '4'` (the wallet declared v4 capability), AND
3. The response's `blockchainData.accounts` is **absent or empty** (the wallet advertises v4 on the wire but does not understand spec-003 multi-network fanout — a genuine capability gap), AND
4. `requiredMinimumVersion >= '4'` (the dApp did not explicitly relax to v3; spec 002).

In this case:
- `requestedNetworks` = the dApp's original list
- `unsupportedNetworks` = the full requested set
- No `AccountInfo` records are added.

> **Narrowed 2026-06-01.** Condition 3 previously also fired on "fewer entries than requested." That clause was removed: a non-empty subset is now valid partial fulfillment (FR-005), not a capability gap. F4 fires only when there is *no* served fanout at all.

## When NOT raised

- **Partial fulfillment (FR-005).** A multi-network request receives a response whose `accounts` map covers a *non-empty subset* of the requested networks → the SDK persists the served accounts and surfaces any advisory `unsupportedNetworks`. No error is raised; the dApp decides whether the subset is sufficient. The error fires only when the served subset is **empty** (F1) or there is **no fanout at all** (F4).
- A single-network request (or no `networks[]`) receives a single-network response → use the existing single-network path. No `NetworksUnsupportedBeaconError`.
- A v3 wallet responds to a v3 dApp → spec 002 already covers this via `VersionUnsupportedBeaconError` for the version mismatch case, or the legacy single-network flow.
- The wallet rejected the request with a wire-level `AbortedBeaconError` (user denied) → existing wire-error path applies; `NetworksUnsupportedBeaconError` is not raised.
- A `requestOperation` on a single-network session without a `network` argument → uses the session's only network (FR-011). Not an error.
- The user manually called `setActiveAccount` to switch among the N records in the session → `getActiveAccount().network.chainId` becomes the implicit target; if the caller still wants to override per call, they pass `network` explicitly.

## Consumer pattern (dApp-side decision)

Under FR-005 partial fulfillment, `requestPermissions` **resolves** even when the wallet can't serve every network — it throws only when the served subset is empty (F1) or there is no fanout at all (F4). The dApp inspects what it got and decides:

```ts
try {
  await client.requestPermissions({ networks: [L1, L2] })

  // Resolved — but the wallet may have served only a subset. Inspect it.
  const served = (await client.getAccounts()).map(a => a.network.chainId)
  const haveL1 = served.includes(L1.chainId)
  const haveL2 = served.includes(L2.chainId)

  if (haveL1 && haveL2) {
    enableFullBridge()
  } else if (haveL1) {
    // Graceful degradation: offer the L1→L2 deposit flow only.
    enableDepositOnly()
  } else {
    showError('This wallet can\'t serve the networks this dApp needs.')
  }
} catch (e) {
  if (e instanceof NetworksUnsupportedBeaconError) {
    // Empty subset (F1) or wallet doesn't understand fanout (F4).
    showError('This wallet doesn\'t support any of the networks this dApp needs.')
  } else {
    throw e
  }
}
```

This is the canonical "inspect served subset + decide" pattern referenced in spec edge case 1. The wallet's optional advisory `unsupportedNetworks` field (when present on the response) lets the dApp distinguish "wallet doesn't know this chain" from "user has no account here" for precise messaging — but the served `accounts` set is authoritative for what the session contains.

## Relationship to `VersionUnsupportedBeaconError` (spec 002)

| | `VersionUnsupportedBeaconError` (spec 002) | `NetworksUnsupportedBeaconError` (spec 003) |
|---|---|---|
| Trigger | Wallet's `peer.version` < dApp's `requiredMinimumVersion` | Served subset empty (F1) / no fanout at all (F4) / operation mis-targeted (F2/F3). A non-empty partial subset does NOT trigger it. |
| Layer | Client-side only | Client-side only |
| Wire registration | NOT in `BeaconErrorType` | NOT in `BeaconErrorType` |
| Discrimination | `instanceof` + `errorCode === 'VERSION_UNSUPPORTED'` | `instanceof` + `errorCode === 'NETWORKS_UNSUPPORTED'` |
| Granularity | Whole-session (one mismatch per peer) | Per-call (FR-005, FR-009, FR-010, FR-019) |
| Caught at | `requestPermissions` resolution | Same call site (`requestPermissions` / `requestOperation`) |

A v4 dApp talking to a v3 wallet first triggers `VersionUnsupportedBeaconError` (spec 002 contract) before `NetworksUnsupportedBeaconError` even has a chance to evaluate. Spec 002 wins; spec 003 applies only on the v4-capable wallet path.
