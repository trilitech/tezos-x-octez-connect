# Quickstart: Multi-Network Protocol Support

**Feature**: 003-multi-network-protocol
**Audience**: implementer of `/speckit-tasks` and reviewer
**Goal**: After running the steps below end-to-end (and the corresponding e2e tests passing for the v4 multi-network matrix cell on every transport), the feature is verifiably done.

## Prerequisites

- Node 18+, `npm` (per existing repo tooling — workspace uses npm, not pnpm).
- A funded ghostnet account; `WALLET_SK` exported (per constitution Principle III).
- The vendored `octez.connect/` packages built locally (`npm run build:packages`).
- The `feat/peer-version-handshake` branch checked out in `octez.connect/` (spec 002 base).

## Bucket A — SDK delta (incremental commits on the open `feat/peer-version-handshake` PR)

### Step 1 — Real `TezosBlockchain.getAccountInfosFromPermissionResponse()`

Replace the stub with a working implementation that mirrors the Sapling blockchain's pattern.

File: `octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts:47-63`

Replacement (sketch):

```ts
async getAccountInfosFromPermissionResponse(
  permissionResponse: PermissionResponseV3<'tezos'>
): Promise<{
  accountId: string;
  address: string;
  publicKey: string;
  network?: Network;
  scopes: PermissionScope[];
}[]> {
  const data = permissionResponse.blockchainData as any
  // v4 multi-network: blockchainData.accounts is a CAIP-2-keyed map
  if (data.accounts && typeof data.accounts === 'object') {
    return Object.entries(data.accounts).map(([chainId, account]: [string, any]) => ({
      accountId: deriveAccountId(account.publicKey, chainId),
      address: account.address,
      publicKey: account.publicKey,
      network: { type: 'custom', chainId, rpcUrl: data.networks?.find((n: any) => n.chainId === chainId)?.rpcUrl },
      scopes: (data.scopes ?? []) as PermissionScope[]
    }))
  }
  // v3 legacy single-network: fall back to the existing shape
  return [{
    accountId: deriveAccountId(data.publicKey, /* legacy network ref */),
    address: data.address,
    publicKey: data.publicKey,
    network: data.network,
    scopes: (data.scopes ?? []) as PermissionScope[]
  }]
}
```

Reference: `octez.connect/packages/octez.connect-blockchain-tezos-sapling/src/blockchain.ts:43-58` for the working Sapling parser.

Verify:

```bash
grep -n "accountId: ''" octez.connect/packages/octez.connect-blockchain-tezos/src/blockchain.ts
# expect: no match (the stub is gone)
```

### Step 2 — Remove the `partialAccountInfos[0]` slice in `DAppClient.permissionRequest`

File: `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts:1518-1551`

Replace the single-record block (lines 1522–1537) with a loop. Conceptual diff:

```diff
  const partialAccountInfos = await blockchain.getAccountInfosFromPermissionResponse(
    response.message
  )

- const accountInfo: any = {
-   accountIdentifier: partialAccountInfos[0].accountId,
-   senderId: response.senderId,
-   origin: { type: connectionInfo.origin, id: connectionInfo.id },
-   address: partialAccountInfos[0].address,
-   publicKey: partialAccountInfos[0].publicKey,
-   scopes: response.message.blockchainData.scopes as any,
-   connectedAt: new Date().getTime(),
-   chainData: response.message.blockchainData
- }
-
- await this.accountManager.addAccount(accountInfo)
- await this.setActiveAccount(accountInfo)
+ const accountInfos: AccountInfo[] = partialAccountInfos.map((p) => ({
+   accountIdentifier: p.accountId,
+   senderId: response.senderId,
+   origin: { type: connectionInfo.origin, id: connectionInfo.id },
+   address: p.address,
+   publicKey: p.publicKey,
+   network: p.network,
+   scopes: p.scopes,
+   connectedAt: Date.now(),
+   chainData: response.message.blockchainData
+ } as AccountInfo))
+
+ for (const ai of accountInfos) {
+   await this.accountManager.addAccount(ai)
+ }
+ if (accountInfos[0]) await this.setActiveAccount(accountInfos[0])
```

Apply the same N→loop pattern to the `notifySuccess` call site (lines 1548–1558) — the `output` payload for the first record matches today's behavior.

Verify:

```bash
grep -n "partialAccountInfos\[0\]" octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts
# expect: 0 matches in permissionRequest path
```

### Step 3 — FR-019 defensive shape-mismatch check

In the same `permissionRequest` function, immediately after the loop in Step 2, add the defensive check (see [contracts/networks-unsupported-error.md](./contracts/networks-unsupported-error.md) F4):

```ts
const requestedNetworks = (request as any).networks?.map((n: any) => n.chainId) ?? []
const servedChainIds = accountInfos.map((a) => a.network?.chainId).filter(Boolean) as string[]
if (requestedNetworks.length >= 2) {
  const missing = requestedNetworks.filter((c: string) => !servedChainIds.includes(c))
  if (missing.length > 0) {
    throw new NetworksUnsupportedBeaconError({
      requestedNetworks,
      unsupportedNetworks: missing,
      // template: "The wallet's response is missing accounts for {missing.length}…"
    })
  }
}
```

### Step 4 — Add `network?: string` to `RequestOperationInput`

File: `octez.connect/packages/octez.connect-types/src/types/RequestOperationInput.ts`

Diff:

```diff
  import { PartialTezosOperation } from './tezos/PartialTezosOperation'

  /**
   * @category DApp
   */
  export interface RequestOperationInput {
    operationDetails: PartialTezosOperation[]
+   /**
+    * Optional CAIP-2 chain id (e.g., 'tezos:NetXsqzbfFenSTS') targeting a specific
+    * network in a multi-network session.
+    */
+   network?: string
  }
```

Also widen `OperationRequestInput.network` to `Network | string` in the wire-type definition file (the on-the-wire shape). Find with:

```bash
grep -rn "interface OperationRequestInput" octez.connect/packages/octez.connect-types/src/
```

### Step 5 — Plumb `input.network` through `DAppClient.requestOperation`

File: `octez.connect/packages/octez.connect-dapp/src/dapp-client/DAppClient.ts:1985-2027`

Insert the resolver before building the request:

```ts
public async requestOperation(input: RequestOperationInput): Promise<OperationResponseOutput> {
  if (!input.operationDetails) {
    throw await this.sendInternalError('Operation details must be provided')
  }
  const activeAccount: AccountInfo | undefined = await this.getActiveAccount()
  if (!activeAccount) {
    throw await this.sendInternalError('No active account!')
  }

  // NEW: resolve target chain id with FR-009/FR-010/FR-011 rules
  const sessionChainIds = (await this.accountManager.getAccounts())
    .map((a) => a.network?.chainId)
    .filter(Boolean) as string[]
  let resolvedNetwork: Network | string
  if (input.network) {
    if (!sessionChainIds.includes(input.network)) {
      throw new NetworksUnsupportedBeaconError({
        requestedNetworks: [input.network],
        unsupportedNetworks: [input.network]
      })
    }
    resolvedNetwork = input.network  // CAIP-2 string form
  } else if (new Set(sessionChainIds).size > 1) {
    throw new NetworksUnsupportedBeaconError({
      requestedNetworks: [],
      unsupportedNetworks: []
      // message: "Multiple networks available; specify a network argument."
    })
  } else {
    resolvedNetwork = activeAccount.network || this.network
  }

  const request: OperationRequestInput = {
    type: BeaconMessageType.OperationRequest,
    network: resolvedNetwork,
    operationDetails: input.operationDetails,
    sourceAddress: activeAccount.address || ''
  }
  // … rest unchanged
}
```

### Step 6 — New error class `NetworksUnsupportedBeaconError`

File: `octez.connect/packages/octez.connect-core/src/errors/NetworksUnsupportedBeaconError.ts` (new)

Template (mirrors `VersionUnsupportedBeaconError`):

```ts
import { BeaconError } from './BeaconError'
import { BeaconErrorType } from '@tezos-x/octez.connect-types'

/**
 * @category Error
 */
export class NetworksUnsupportedBeaconError extends BeaconError {
  public name: string = 'NetworksUnsupportedBeaconError'
  public title: string = 'Networks Not Supported'
  public readonly errorCode = 'NETWORKS_UNSUPPORTED' as const
  public readonly requestedNetworks: string[]
  public readonly unsupportedNetworks: string[]

  constructor(input: {
    requestedNetworks: string[]
    unsupportedNetworks: string[]
    customMessage?: string
  }) {
    super(
      BeaconErrorType.UNKNOWN_ERROR,                    // sentinel — error is never serialized
      input.customMessage ?? defaultMessage(input),
      undefined as any                                   // no wire error-code mapping
    )
    this.requestedNetworks = input.requestedNetworks
    this.unsupportedNetworks = input.unsupportedNetworks
  }
}

function defaultMessage(input: { requestedNetworks: string[]; unsupportedNetworks: string[] }): string {
  if (input.unsupportedNetworks.length === 0 && input.requestedNetworks.length === 0) {
    return 'Multiple networks available in this session; specify a network argument on requestOperation.'
  }
  return `The wallet cannot serve all requested networks. Unsupported: ${input.unsupportedNetworks.join(', ')}.`
}
```

Then re-export from `octez.connect-core/src/index.ts` alongside the spec 002 errors:

```ts
export { NetworksUnsupportedBeaconError } from './errors/NetworksUnsupportedBeaconError'
```

### Step 7 — Build & SDK integration test

```bash
cd octez.connect
npm run build:packages
npx tsc --noEmit -p packages/octez.connect-dapp
npx tsc --noEmit -p packages/octez.connect-core
npx tsc --noEmit -p packages/octez.connect-types
```

Add at least one integration test under `octez.connect/packages/octez.connect-dapp/test/` that exercises:
- Multi-network permission response → N AccountInfo records persisted (Contract C6).
- `requestOperation({ network })` with valid CAIP-2 → outgoing message has string form (Contract O3 + W1).
- `requestOperation({ network })` with mismatched CAIP-2 → `NetworksUnsupportedBeaconError` thrown before wire send (Contract O3).
- `requestOperation()` with no network on a multi-network session → `NetworksUnsupportedBeaconError` thrown (Contract O4).
- v4 wallet response missing `accounts[]` fanout → `NetworksUnsupportedBeaconError` thrown (Contract C8 / F4).

Commit each step as its own commit on `feat/peer-version-handshake` so the SDK PR's history reads cleanly.

## Bucket B — Outer repo (new PR off `003-multi-network-protocol`)

### Step 8 — Remove dApp monkey-patches

Files:
- `wc2/dapp/src/main.ts:335-343` — delete the `(client as any).makeRequest` monkey-patch block.
- `dapp/src/index.ts` — same pattern (`/request-operation` handler).

At the call site, switch to:

```ts
await client.requestOperation({
  network: chainId,
  operationDetails: [...]
})
```

Verify:

```bash
grep -rn "(client as any).makeRequest" wc2/ dapp/
# expect: zero matches
```

### Step 9 — Refactor reference wallets to the integrator dispatch pattern

Files:
- `wallet/src/index.ts:319-401` — replace inline `if (typeof networkField === 'string')` / `if (isL2)` branching with the dispatch-table pattern from [data-model.md](./data-model.md) "Integrator Dispatch Pattern".
- `wc2/wallet/src/main.ts` — same pattern.

Both ref wallets MUST end up with the same shape:

```ts
const handlers: Record<string, BlockchainHandlerBundle> = {
  'tezos:NetXsqzbfFenSTS': l1Handler,
  'tezos:NetXY2oPPzkxUW1': l2Handler,
}

client.connect(async (message) => {
  const chainId = extractChainId(message)
  const handler = handlers[chainId] ?? defaultHandler
  return handler[messageTypeToMethod(message.type)](message)
})
```

### Step 10 — Integration guide update

File: `docs/wallet-multichain-integration.md`

Add a new section (insert after §3 or wherever the wallet integration narrative lives):

- **§X. Recommended integrator dispatch pattern**
  - Copy the worked example from [data-model.md](./data-model.md) (the `Record<chainId, BlockchainHandlerBundle>` snippet).
  - Cross-reference the reference wallets as the canonical worked example, citing the new demo-branch HEAD commit id.
  - Fit in <100 lines including comments (SC-005).

Also update §4 (backward-compat matrix) with the new FR-019 cell: `v4-multi-network dApp × v4-single-network wallet → NetworksUnsupportedBeaconError`.

### Step 11 — E2E test scaffolds

Create `test/phase-multi-network/`:

- `multi-network-operation-p2p.ts` — Matrix P2P: connect with L1+L2, issue an operation on L1, issue an operation on L2 in the same session, assert both confirm on their respective RPCs (SC-007).
- `multi-network-operation-walletconnect.ts` — same for WC2.
- `multi-network-operation-postmessage.spec.ts` — same for Playwright/popup.
- `multi-network-fr019-defensive.ts` — `requiredMinimumVersion='4'` dApp talks to a wallet pinned to "v4 but no spec 003 fanout" via the `/test-config` endpoint (spec 002 T046); assert `NetworksUnsupportedBeaconError` is raised.

Wire each scaffold into `package.json` scripts following the spec 002 naming convention (`test:pv-*` → `test:mn-*`).

### Step 12 — Website + README

Files:
- `proposal.html` — add a short note in the "Protocol change demonstration" section about the multi-network ergonomics tail; cite the updated demo-branch HEAD commit id.
- `poc-plan.html` — same.
- `README.md` — refresh the demo-branch HEAD pointer; add a row in the spec table for spec 003.

### Step 13 — Cross-bucket verification

With Bucket A's SDK linked into the outer repo (`npm link` per spec 002 demo-branch.md instructions):

```bash
npm run test:mn-all          # all multi-network e2e scaffolds
npm run test:pv-all          # spec 002 negotiation matrix — must remain green
npm run test:phase2          # legacy single-network end-to-end — must remain green
```

All three command groups MUST be green before the spec is declared done.

## Definition of Done

- [ ] Bucket A SDK delta committed to `feat/peer-version-handshake` (5 commits, one per Step 1–6 + 7's test).
- [ ] `feat/peer-version-handshake` PR description updated to mention spec 003 inclusion.
- [ ] Bucket B outer-repo PR opened with reference apps + integration guide + tests + website edits.
- [ ] All e2e suites green: `phase2`, `pv-*` (spec 002 matrix), `mn-*` (spec 003 matrix).
- [ ] Grep verifications pass: no `(client as any).makeRequest` in reference dApps; no `partialAccountInfos[0]` slice in the SDK; no inline `if (chainId === ...)` in reference wallets.
- [ ] Constitution attestation appended (Principles I–V each addressed; see spec 002's `constitution-attestation.md` for the template).
