---
title: Tezos X — Multi-chain Beacon integration guide
description: Protocol changes and implementation guide for wallet developers
date: 2026-04-17
status: draft
---

# Tezos X — Multi-chain Beacon integration guide

## Context

Tezos X introduces a dual-runtime architecture: an **EVM interface** (Etherlink) and a **Michelson interface** (same account model as L1, TZIP-compatible RPCs). A single user may hold the same key on both runtimes and want to sign operations on either within a single dApp session.

This document specifies the minimal changes required to the [TZIP-10](https://gitlab.com/tezos/tzip/-/blob/master/proposals/tzip-10/tzip-10.md) Beacon protocol to support multi-chain sessions, and provides implementation guidance for two wallet archetypes:

1. **Chrome extension wallet** — injects into the page, uses the existing PostMessage channel
2. **Standalone app wallet** — web app or mobile app; uses Matrix P2P pairing or a new popup transport

The changes are **backward compatible**: an upgraded wallet (one whose
`BEACON_VERSION = '4'`) MUST continue to serve every previously-published
`peer.version` (including `'3'` for today's deployed dApps); unupgraded
wallets need no modification at all.

> ⚠️ **Approach revised.** §2 and §3 below preserve the original POC's
> code examples for historical context (they show `msg.networks ?? []`
> field-presence checks). The **production contract is in §4**:
> wallets route on `peer.version >= '4'` at a single entry point;
> the dApp-side SDK detects unupgraded wallets via the wallet's
> response `peer.version` and raises `VersionUnsupportedBeaconError`.
> No new wire field is introduced. Reference SDK implementation:
> [`octez.connect@feat/peer-version-handshake`](https://github.com/trilitech/octez.connect/tree/feat/peer-version-handshake)
> (head `ac3194a1`, see [`demo-branch.md`](../specs/002-peer-version-handshake/demo-branch.md) for full
> commit list). Implementers should follow §4 and treat §2/§3
> code samples as **illustrations of the protocol-level payload
> shapes only**, not as the recommended routing pattern.

---

## 1. Protocol changes

### 1.1 `permission_request` — new optional `networks[]` field

A dApp that wants a multi-chain session includes a `networks` array in the permission request:

```json
{
  "type": "permission_request",
  "appMetadata": { "name": "My dApp" },
  "network": { "type": "custom", "rpcUrl": "..." },
  "scopes": ["operation_request"],

  "networks": [
    {
      "chainId": "tezos:NetXsqzbfFenSTS",
      "rpcUrl": "https://rpc.shadownet.teztnets.com",
      "name": "Tezos X L1"
    },
    {
      "chainId": "tezos:NetXY2oPPzkxUW1",
      "rpcUrl": "https://demo.txpark.nomadic-labs.com/rpc/tezlink",
      "name": "Tezos X Michelson interface"
    }
  ]
}
```

**Field details:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chainId` | string | yes | [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain identifier: `tezos:<chain-id-b58>` |
| `rpcUrl` | string | recommended | RPC endpoint for this chain. The wallet should store this and use it to inject operations. |
| `name` | string | no | Human-readable label to show in the approval UI |

If `networks[]` is **absent**, the wallet behaves exactly as before (standard TZIP-10 v2, single-chain).

### 1.2 `permission_response` — new optional `accounts` map

If the wallet accepts a multi-chain request, it includes an `accounts` map in the response:

```json
{
  "type": "permission_response",
  "id": "<request-id>",
  "publicKey": "edpk...",
  "scopes": ["operation_request"],

  "accounts": {
    "tezos:NetXsqzbfFenSTS": { "publicKey": "edpk..." },
    "tezos:NetXY2oPPzkxUW1": { "publicKey": "edpk..." }
  }
}
```

**Key points:**

- `accounts` keys are the CAIP-2 chain IDs from the request.
- For Tezos-family chains, the same Ed25519 key pair is valid across all chains (L1 and Michelson interface share the same address format `tz1…`). The wallet returns the same `publicKey` for each chain.
- `publicKey` at the top level is kept for backward compat.
- The dApp detects the response version by checking: `'accounts' in response ? v3 : v2`.

### 1.3 `operation_request` — `network` field now accepts a CAIP-2 string

The `network` field on `operation_request` can now be a bare CAIP-2 string:

```json
{
  "type": "operation_request",
  "id": "<request-id>",
  "operationDetails": [...],

  "network": "tezos:NetXY2oPPzkxUW1"
}
```

The wallet uses this chain ID to look up the RPC endpoint it stored during the permission phase, then injects the operation there.

**Backward compat:** if `network` is an object (TZIP-10 v2 format), the wallet falls back to reading `network.rpcUrl` or `network.type` as before.

### 1.4 Summary of changes

| Message | Field | Change |
|---------|-------|--------|
| `permission_request` | `networks[]` | New optional array. Presence signals a multi-chain request. |
| `permission_response` | `accounts` | New optional map `{chainId → {publicKey}}`. Presence signals multi-chain approval. |
| `operation_request` | `network` | Now accepts a CAIP-2 string in addition to the existing object format. |

---

## 2. Chrome extension wallet

### How Chrome extension wallets work with Beacon

A Chrome extension wallet typically:
1. Injects a content script into every page
2. The content script listens for `window.postMessage` from the page (from the Beacon dApp SDK)
3. Messages are forwarded to the extension background service worker via `chrome.runtime.sendMessage`
4. The background opens an extension popup for user approval, then sends the response back

**No transport changes are needed.** The existing PostMessage ↔ `chrome.runtime` channel continues to work. Only the message payload handling changes.

### 2.1 Handle `networks[]` in `permission_request`

In the message handler that receives `permission_request` (background script or popup):

```typescript
if (message.type === 'permission_request') {
  const networks: Array<{ chainId: string; rpcUrl?: string; name?: string }>
    = message.networks ?? []

  if (networks.length > 0) {
    // Multi-chain request: present approval UI listing all requested chains
    const approved = await showMultiChainApprovalUI(message.appMetadata.name, networks)
    if (!approved) {
      sendError(message.id, 'ABORTED_ERROR')
      return
    }

    // Build network registry for later operation routing
    const networkRegistry: Record<string, string> = {}
    const accounts: Record<string, { publicKey: string }> = {}

    for (const net of networks) {
      accounts[net.chainId] = { publicKey: wallet.publicKey }
      if (net.rpcUrl) networkRegistry[net.chainId] = net.rpcUrl
    }

    // Store registry in extension storage for the active session
    await chrome.storage.session.set({ networkRegistry })

    sendResponse({
      type: 'permission_response',
      id: message.id,
      publicKey: wallet.publicKey,
      accounts,                         // ← new field
      network: message.network,
      scopes: message.scopes,
    })

  } else {
    // Legacy v2 path — single-chain, no change
    sendLegacyPermissionResponse(message)
  }
}
```

### 2.2 Approval UI

The approval popup should list each requested chain with its name and chain ID:

```
My dApp wants to connect to:

  ● Tezos X L1          (tezos:NetXsqzbfFenSTS)
  ● Michelson interface (tezos:NetXY2oPPzkxUW1)

  Your address: tz1VSUr8…Cjcjb

  [Reject]   [Connect]
```

The user approves or rejects the **entire session** (not per-chain). Partial approval (some chains but not others) is not part of this extension.

### 2.3 Route operations by chain ID

In the `operation_request` handler:

```typescript
if (message.type === 'operation_request') {
  const networkField = message.network

  let chainId: string
  let rpcUrl: string

  if (typeof networkField === 'string') {
    // New format: CAIP-2 string
    chainId = networkField.startsWith('tezos:') ? networkField : `tezos:${networkField}`
    const registry = (await chrome.storage.session.get('networkRegistry')).networkRegistry ?? {}
    rpcUrl = registry[chainId] ?? fallbackRpcForChain(chainId)
  } else {
    // Legacy format: { type, rpcUrl, name, ... }
    rpcUrl = networkField?.rpcUrl ?? DEFAULT_L1_RPC
    chainId = `tezos:${networkField?.chainId ?? ''}`
  }

  // Inject the operation using rpcUrl
  const hash = await injectOperation(rpcUrl, message.operationDetails, wallet.secretKey)
  sendResponse({ type: 'operation_response', id: message.id, transactionHash: hash })
}
```

### 2.4 Fee estimation on the Michelson interface

The Michelson interface has different mempool parameters from mainnet (higher fee floor). **Auto-computed fees from the SDK will be too low and the operation will be rejected.**

You must explicitly estimate fees via the RPC before injecting:

```typescript
// Using Taquito (recommended):
const tezos = new TezosToolkit(rpcUrl)
tezos.setSignerProvider(signer)

// For Michelson interface operations, estimate explicitly:
const estimates = await tezos.estimate.batch(operations)
const opsWithFees = operations.map((op, i) => ({
  ...op,
  fee: estimates[i].suggestedFeeMutez,
  gasLimit: estimates[i].gasLimit,
  storageLimit: estimates[i].storageLimit,
}))
const result = await tezos.contract.batch(opsWithFees).send()
```

You can detect the Michelson interface by checking the chain ID (`NetXY2oPPzkxUW1`) or by calling `/chains/main/mempool/filter` on the RPC and checking `minimal_fees` > 100.

---

## 3. Standalone app wallet

A standalone wallet (web app or mobile app not delivered as a browser extension) does not have access to the page's JavaScript context, so it cannot intercept `window.postMessage` directly.

Two transport options are available:

### 3.1 Matrix P2P transport (existing, extended)

The existing TZIP-10 pairing flow (QR code → Matrix room → encrypted messages) continues to work. The only change is in the message payload: handle `networks[]` on `permission_request` and return `accounts` on `permission_response`, exactly as described for Chrome extensions in §2.1–2.3.

**No changes to the pairing handshake or Matrix transport are needed.**

### 3.2 Popup transport (`tzip10-popup`) — new

The dApp opens the wallet as a browser popup via `window.open()`. Communication is via cross-origin `postMessage`. This transport is useful when the wallet is a web app hosted on its own domain (e.g., `wallet.example.com`).

The dApp calls:
```javascript
const popup = window.open('https://wallet.example.com/?popup=1', 'wallet', 'width=480,height=700')
```

#### Protocol message sequence

All messages use `{ type: 'tzip10-popup', action: '...', ... }`.

```
dApp opens popup at walletUrl?popup=1
                    │
                    ▼
Wallet loads, detects ?popup=1 and window.opener ≠ null
                    │
wallet ──────────── wallet-ready ──────────────────▶ dApp
                    │
dApp ────────────── permission-request ────────────▶ wallet
                    │
          User approves (or wallet auto-approves)
                    │
wallet ──────────── permission-response ───────────▶ dApp
                    │
           Session active; popup stays open
                    │
dApp ────────────── operation-request ─────────────▶ wallet
                    │
          Wallet signs and injects
                    │
wallet ──────────── operation-response ────────────▶ dApp
```

#### Message format reference

**`wallet-ready`** (wallet → dApp, on load):
```json
{ "type": "tzip10-popup", "action": "wallet-ready", "address": "tz1…" }
```

**`permission-request`** (dApp → wallet):
```json
{
  "type": "tzip10-popup",
  "action": "permission-request",
  "id": "<uuid>",
  "appName": "My dApp",
  "networks": [
    { "chainId": "tezos:NetXsqzbfFenSTS", "rpcUrl": "...", "name": "Tezos X L1" },
    { "chainId": "tezos:NetXY2oPPzkxUW1", "rpcUrl": "...", "name": "Michelson interface" }
  ]
}
```

**`permission-response`** (wallet → dApp, on approval):
```json
{
  "type": "tzip10-popup",
  "action": "permission-response",
  "id": "<same-uuid>",
  "publicKey": "edpk…",
  "accounts": {
    "tezos:NetXsqzbfFenSTS": { "publicKey": "edpk…" },
    "tezos:NetXY2oPPzkxUW1": { "publicKey": "edpk…" }
  }
}
```

**`permission-error`** (wallet → dApp, on rejection):
```json
{ "type": "tzip10-popup", "action": "permission-error", "id": "<uuid>", "errorType": "ABORTED_ERROR" }
```

**`operation-request`** (dApp → wallet):
```json
{
  "type": "tzip10-popup",
  "action": "operation-request",
  "id": "<uuid>",
  "appName": "My dApp",
  "chainId": "tezos:NetXY2oPPzkxUW1",
  "operations": [
    {
      "kind": "transaction",
      "amount": "0",
      "destination": "KT1…",
      "parameters": { "entrypoint": "default", "value": { "string": "hello" } }
    }
  ]
}
```

**`operation-response`** (wallet → dApp, on success):
```json
{
  "type": "tzip10-popup",
  "action": "operation-response",
  "id": "<same-uuid>",
  "transactionHash": "oo…"
}
```

**`operation-error`** (wallet → dApp, on failure):
```json
{ "type": "tzip10-popup", "action": "operation-error", "id": "<uuid>", "error": "insufficient_fees" }
```

#### Wallet implementation (skeleton)

```typescript
async function initPopupMode(signer: Signer): Promise<void> {
  // Guard: only enter popup mode if correctly opened as a popup
  if (!new URLSearchParams(location.search).has('popup') || !window.opener) return

  const opener = window.opener as Window
  const send = (msg: object) => opener.postMessage(msg, '*')

  let networkRegistry: Record<string, string> = {}

  // Step 1: announce ready
  send({ type: 'tzip10-popup', action: 'wallet-ready', address: await signer.publicKeyHash() })

  // Step 2: handle incoming messages
  window.addEventListener('message', async (event: MessageEvent) => {
    const msg = event.data
    if (!msg || msg.type !== 'tzip10-popup') return

    if (msg.action === 'permission-request') {
      const networks: Array<{ chainId: string; rpcUrl?: string; name?: string }> = msg.networks ?? []

      const approved = await showApprovalUI(msg.appName, networks)  // or auto-approve in headless mode
      if (!approved) {
        send({ type: 'tzip10-popup', action: 'permission-error', id: msg.id, errorType: 'ABORTED_ERROR' })
        return
      }

      networkRegistry = {}
      const accounts: Record<string, { publicKey: string }> = {}
      const publicKey = await signer.publicKey()

      for (const net of networks) {
        accounts[net.chainId] = { publicKey }
        if (net.rpcUrl) networkRegistry[net.chainId] = net.rpcUrl
      }

      send({ type: 'tzip10-popup', action: 'permission-response', id: msg.id, publicKey, accounts })
    }

    if (msg.action === 'operation-request') {
      const { chainId, operations, id, appName } = msg
      const rpcUrl = networkRegistry[chainId] ?? fallbackRpcForChain(chainId)

      const approved = await showOperationUI(appName, chainId, operations)
      if (!approved) {
        send({ type: 'tzip10-popup', action: 'operation-error', id, error: 'ABORTED_ERROR' })
        return
      }

      try {
        const hash = await injectOperation(signer, rpcUrl, operations)
        send({ type: 'tzip10-popup', action: 'operation-response', id, transactionHash: hash })
      } catch (err: any) {
        send({ type: 'tzip10-popup', action: 'operation-error', id, error: err.message })
      }
    }
  })
}
```

#### Security notes

- **`postMessage` origin**: The wallet should validate `event.origin` against a known list of trusted dApp origins, or at minimum log unknown origins.
- **Popup blocker**: `window.open()` must be called from a user gesture (click handler). If the popup is blocked, the dApp should detect `popupWindow === null` and fall back to Matrix pairing.
- **`window.opener` access**: Cross-origin `postMessage` to `window.opener` works in all modern browsers. The wallet does not need read access to the opener's DOM.

---

## 3a. Recommended integrator dispatch pattern (spec 003)

The wallet SDK's public surface is intentionally thin: `WalletClient.connect(callback)` delivers every incoming message to the integrator unchanged. Per-blockchain logic — RPC selection, fee estimation, protocol-specific signing, error mapping — is the **integrator's responsibility**. The following pattern is the recommended shape; integrators MAY implement equivalent logic differently as long as conformance rules C1–C5 (§4) hold.

The pattern is a **CAIP-2-keyed dispatch table**:

```typescript
type BlockchainHandlerBundle = {
  rpcUrl: string
  onPermission: (chainId: string, publicKey: string) => Promise<{ publicKey: string }>
  executeOps: (signer: InMemorySigner, operations: any[]) => Promise<string>
}

const L1_CHAIN = 'tezos:NetXsqzbfFenSTS'
const L2_CHAIN = 'tezos:NetXY2oPPzkxUW1'

const handlers: Record<string, BlockchainHandlerBundle> = {
  [L1_CHAIN]: {
    rpcUrl: 'https://rpc.shadownet.teztnets.com',
    onPermission: async (_chainId, publicKey) => ({ publicKey }),
    executeOps: (signer, ops) => executeL1Ops(signer, L1_RPC, ops),
  },
  [L2_CHAIN]: {
    rpcUrl: 'https://michelson.previewnet.tezosx.nomadic-labs.com',
    onPermission: async (_chainId, publicKey) => ({ publicKey }),
    executeOps: (signer, ops) => executeL2Ops(signer, L2_RPC, ops),
  },
}

await client.connect(async (message) => {
  if (message.type === BeaconMessageType.PermissionRequest && Number(peer.version) >= 4) {
    const incomingNetworks: Array<{ chainId: string }> = (message as any).networks ?? []
    const requestedChainIds = incomingNetworks.map((n) =>
      n.chainId.startsWith('tezos:') ? n.chainId : `tezos:${n.chainId}`,
    )
    // FR-005 emit-side: reject if any chain id is unsupported.
    const unsupportedNetworks = requestedChainIds.filter((c) => !handlers[c])
    if (unsupportedNetworks.length > 0) {
      await client.respond({
        type: BeaconMessageType.Error,
        id: message.id,
        errorType: 'NETWORK_NOT_SUPPORTED',
        unsupportedNetworks,
      } as any)
      return
    }
    const accounts: Record<string, { publicKey: string }> = {}
    for (const chainId of requestedChainIds) {
      accounts[chainId] = await handlers[chainId].onPermission(chainId, publicKey)
    }
    await client.respond({ type: BeaconMessageType.PermissionResponse, ..., accounts })
  }

  if (message.type === BeaconMessageType.OperationRequest) {
    const chainId =
      typeof message.network === 'string'
        ? (message.network.startsWith('tezos:') ? message.network : `tezos:${message.network}`)
        : `tezos:${(message.network as any).chainId ?? 'NetXsqzbfFenSTS'}`
    const handler = handlers[chainId]
    if (!handler) {
      await client.respond({
        type: BeaconMessageType.Error,
        id: message.id,
        errorType: 'NETWORK_NOT_SUPPORTED',
        unsupportedNetworks: [chainId],
      } as any)
      return
    }
    const hash = await handler.executeOps(signer, message.operationDetails)
    await client.respond({ type: BeaconMessageType.OperationResponse, id: message.id, transactionHash: hash })
  }
})
```

**Why this shape.** A dispatch table is grep-able, testable per chain in isolation, and adds a new blockchain in one entry without touching the SDK. The `if (chainId === ...)` chain that wallet integrators tend to grow inline is replaced by a lookup, which preserves the spec 002 "no field-presence detection" guarantee on the routing path.

**Reference implementation.** Both reference wallets in this repo (`wallet/src/index.ts` and `wc2/wallet/src/main.ts`) follow this pattern after spec 003 lands. See the [`feat/peer-version-handshake`](https://github.com/trilitech/octez.connect/tree/feat/peer-version-handshake) branch for the SDK delta they consume.

**This pattern is documentary, not SDK-enforced.** The wallet SDK does not impose this shape — integrators are free to dispatch differently as long as constitution Principles I (backward compat) and IV (reference parity) hold.

---

## 4. Backward compatibility matrix

**Routing key.** All matrix cells below are determined by the value of
the existing `peer.version` field on each side's pairing/connect
payload. This field is already on every Beacon message — no new
version field is introduced by this protocol revision.

| dApp's `peer.version` | Wallet's served `peer.version` | Behaviour |
|-----------------------|-------------------------------|-----------|
| `'3'` (legacy single-chain dApp) | `'3'` (legacy wallet) | Standard TZIP-10 v2 — single chain, existing behaviour unchanged. |
| `'3'` (legacy single-chain dApp) | `'4'` (upgraded wallet) | Wallet MUST serve at `'3'` — backward compat is mandatory, not policy. Existing dApps need no change. |
| `'4'` (multi-chain dApp) | `'4'` (upgraded wallet) | Multi-chain session. Wallet reads `req.networks`; returns `accounts` map. |
| `'4'` (multi-chain dApp) | `'3'` (unupgraded wallet) | Wallet behaves as legacy (no code change possible). dApp-side SDK detects the mismatch from `walletResponse.version` and raises `VersionUnsupportedBeaconError`. |
| `'4'` multi-network dApp asking ≥ 2 networks | `'4'` wallet that doesn't fan out accounts | Spec 003 FR-019 defensive. dApp-side SDK detects the missing `accounts[]` map after a `>= 2` `networks[]` request and raises `NetworksUnsupportedBeaconError` with `unsupportedNetworks` populated from the set difference. No partial session is created. |
| `'4'` multi-network dApp | `'4'` wallet that doesn't support every requested chain | Spec 003 FR-005 emit-side. Wallet emits a wire-level error response with `errorType: 'NETWORK_NOT_SUPPORTED'` + `unsupportedNetworks: string[]`. dApp SDK materializes this as `NetworksUnsupportedBeaconError`. Whole-request rejection — no partial fulfillment. |

### Conformance rules

- **C1.** An upgraded wallet (any wallet whose `BEACON_VERSION = '4'`) MUST accept and serve sessions for every legal `peer.version` value `v` such that `v <= BEACON_VERSION`. Backward compatibility is mandatory.
- **C2.** Wallets MUST NOT emit a wire-level `version_unsupported` rejection for any `peer.version` value received. If the value exceeds the wallet's own `BEACON_VERSION`, the wallet responds with `version = BEACON_VERSION` (its own served version) and the dApp SDK decides whether that is acceptable.
- **C3.** A dApp SDK MUST stamp every outgoing pairing payload and message with its build-time `BEACON_VERSION`.
- **C4.** Comparison MUST be numeric integer comparison (`Number(a) >= Number(b)`). String-lexicographic comparison is forbidden (would mis-order `'10'` vs `'4'` at future revisions).
- **C5.** No participant may invent a sibling version-equivalent field (capabilities, protocolFlavor, tier, …) to bypass the `peer.version` routing key.
- **C6 (spec 003).** A wallet that cannot serve every chain id in `permission_request.networks[]` MUST reject the whole request with `errorType: 'NETWORK_NOT_SUPPORTED'` + `unsupportedNetworks: string[]`. Partial fulfillment (returning a smaller `accounts[]` map) is forbidden — it would create ambiguous session state. See spec 003 FR-005 + contracts/networks-unsupported-error.md F1.
- **C7 (spec 003).** A dApp issuing `requestOperation` on a session with ≥ 2 networks MUST pass an explicit `network: <CAIP-2>` argument. The SDK rejects an omitted argument with `NetworksUnsupportedBeaconError`. Single-network sessions remain backward compatible: omitted `network` uses the session's only chain id.

### Detection on the dApp side

The dApp configures a required-minimum at SDK construction; the SDK does the comparison and raises a structured error on mismatch.

```typescript
import { DAppClient, VersionUnsupportedBeaconError } from '@tezos-x/octez.connect-dapp'

const client = new DAppClient({
  name: 'My multi-chain dApp',
  // Default = SDK's BEACON_VERSION. Override to '3' for tolerance.
  requiredMinimumVersion: '4',
})

try {
  const response = await client.requestPermissions({ networks: [...] })
  // peer.version >= '4' was served — response.accounts is the per-chain map.
} catch (e) {
  if (e instanceof VersionUnsupportedBeaconError) {
    // walletServedVersion < requiredMinimumVersion
    showWalletUpgradeBanner({
      required: e.requiredMinimumVersion,   // e.g. '4'
      served:   e.walletServedVersion,      // e.g. '3'
      message:  e.message,
    })
  } else {
    throw e
  }
}
```

### Routing on the wallet side

The wallet branches once at its incoming-request entry point.
Downstream handlers MUST NOT re-check the version or do field-presence
detection of v4-era fields.

```typescript
// In IncomingRequestInterceptor.intercept() — the single choke point.
if (Number(peer.version) >= 4) {
  return handleV4Message(req, peer)   // reads req.networks directly
}
if (peer.version === '2') return handleV2Message(req, peer)
if (usesWrappedMessages(peer.version)) return handleV3Message(req, peer)
```

### Future versions

The set of legal `peer.version` values is open-ended (`'5'`, `'6'`, …
are reserved for future protocol revisions). Adding a new value
requires (a) bumping `BEACON_VERSION` in `octez.connect-core/src/constants.ts`,
(b) defining the message-shape delta in this guide, and (c) adding the
corresponding branch in the wallet's single-routing entry. The dApp
SDK's `requiredMinimumVersion` mechanism propagates automatically:
SDKs built against `BEACON_VERSION = '5'` default to a minimum of
`'5'` and raise `VersionUnsupportedBeaconError` against any wallet
served at `'4'` or below.

A future protocol revision MUST NOT introduce a new wire field to
carry version information. The negotiation contract names
`peer.version` as the sole identifier (see C5).

---

## 5. Reference implementation

**SDK changes.** The reference SDK implementation lives on the
[`feat/peer-version-handshake`](https://github.com/trilitech/octez.connect/tree/feat/peer-version-handshake)
branch of [`trilitech/octez.connect`](https://github.com/trilitech/octez.connect),
head commit `ac3194a1` (4 commits ahead of master). See
[`specs/002-peer-version-handshake/demo-branch.md`](../specs/002-peer-version-handshake/demo-branch.md)
in this repo for reproduction steps. The branch contains three
reviewable commits (foundational scaffolding + wallet single-branch
routing + dApp-side detection).

**Reference apps.** A working POC of the consuming side is in this
repo at `wc2/wallet/src/main.ts` (browser wallet) and `wc2/dapp/src/main.ts` (dApp).

Validated transports:

| Transport | Status | Test |
|-----------|--------|------|
| Matrix P2P (TZIP-10 extension) | ✓ validated | `wc2/` browser wallet + dApp |
| WalletConnect v2 | ✓ validated | `test/phase5.ts` |
| Popup (`tzip10-popup`) | ✓ validated | `test/phase6.ts` (Playwright) |

Chains tested: Shadownet L1 (`tezos:NetXsqzbfFenSTS`) + Michelson interface (`tezos:NetXY2oPPzkxUW1`).

---

## 6. Error surface — dApp-observable errors during upgrade

The following SDK-internal errors are surfaced to dApp integrators during
the v4 protocol rollout. None of them cross the wire; all are thrown by
the dApp-side SDK only.

### `VersionUnsupportedBeaconError`

Thrown when a paired wallet's persisted `peer.version` is below the dApp's
declared `requiredMinimumVersion`. Carries `requiredMinimumVersion` and
`walletServedVersion`. Resolution: ask the user to upgrade the wallet.

### `NetworksUnsupportedBeaconError`

Thrown when a `requestPermissions({ networks: […] })` call asks for ≥ 2
networks and the v4 wallet responds without an `accounts[]` fanout
(or for `requestOperation({ network })` calls targeting a chain id not in
the session). Carries `requestedNetworks` and `unsupportedNetworks`.
Resolution: prompt the user to re-pair with a wallet that supports all
requested chains.

### `InvalidBeaconVersionError` (spec 004 / PR #31 remediation)

Thrown by `compareBeaconVersion()` (used internally by the routing and
version-gating helpers) when a `peer.version` operand fails strict
decimal-integer validation — non-string types, leading sign, leading
zeros, decimal points, exponent notation, whitespace, or hex prefix.

Catch sites: the wallet's `IncomingRequestInterceptor` catches this and
routes the message via the legacy branch (with a `logger.warn` for
forensics). The dApp's version-gating helpers let it propagate — at the
dApp layer, the input comes from the persisted `PeerManager` record, so
a malformed value indicates corruption worth surfacing.

### `StalePermissionSchemeError` (spec 004 / PR #31 remediation)

Thrown by `PermissionValidator` when a v4 Tezos `OperationRequest`
cannot resolve against any persisted `PermissionInfo` by the new
`accountIdentifier` scheme, but a record matching the same
`(address, chainId)` pair exists under an older scheme. Carries
`address`, `chainId`, and `nextStep` (a user-facing remediation message).

**Why integrators may see this:** before PR #31, the Tezos SDK derived
multi-network `accountId` values via the now-deprecated
`${publicKey}-${chainId}` scheme, which did not match the
`getAccountIdentifier(address, network)` scheme used by
`PermissionValidator` for lookup. A dApp that paired under a pre-PR-#31
SDK has on-disk permission records keyed under the broken scheme. The
new SDK detects this scheme-agnostically and surfaces a clear typed
error rather than a generic `MissingPermissionError`.

**Resolution:** re-pair the dApp with the wallet. The new pairing
materialises `PermissionInfo` under the corrected scheme, and the error
will not re-fire for that account.

No automatic migration is performed — the v4 audience before PR #31
remediation was internal-only (the `feat/peer-version-handshake`
branch demo), so a clean re-pair is the safest upgrade path.
