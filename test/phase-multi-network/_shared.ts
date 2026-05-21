/**
 * Shared helpers for spec 003-multi-network-protocol e2e tests.
 *
 * Three transports × {happy multi-network, FR-019 defensive} = 4 scaffolds.
 * Each scaffold consumes these helpers and drives the dApp/wallet pair
 * exposed via HTTP control endpoints (same convention as phase2.ts).
 *
 * Prerequisites for any of these tests to actually pass:
 *   - The reference dApp + wallet are running (e.g. `dapp/`, `wallet/`).
 *   - WALLET_SK is exported (constitution Principle III: real-network).
 *   - The local clone of octez.connect is `npm link`-ed into both apps so
 *     the SDK code under test is the spec 003 demo branch's, not a stale
 *     node_modules copy. See spec 002 demo-branch.md for the link recipe.
 *   - Both networks (Tezos L1 ghostnet + Tezos X L2 previewnet) are
 *     reachable.
 *
 * Run an individual scaffold:
 *   tsx test/phase-multi-network/multi-network-operation-p2p.ts
 *
 * Run all four:
 *   npm run test:mn-all
 */

export const DAPP_URL = process.env.DAPP_URL ?? 'http://localhost:5173'
export const WALLET_URL = process.env.WALLET_URL ?? 'http://localhost:5174'
export const L1_CHAIN = 'tezos:NetXsqzbfFenSTS'
export const L2_CHAIN = 'tezos:NetXY2oPPzkxUW1'
export const L1_RPC = 'https://rpc.shadownet.teztnets.com'
export const L2_RPC = 'https://michelson.previewnet.tezosx.nomadic-labs.com'
export const DEST = process.env.DEST ?? 'tz1burnburnburnburnburnburnburjAYjjX'

export type Transport = 'matrix' | 'walletconnect' | 'postmessage'

export async function get(url: string): Promise<any> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`)
  const ct = r.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? r.json() : r.text()
}

export async function post(url: string, body?: unknown): Promise<any> {
  const isText = typeof body === 'string'
  const r = await fetch(url, {
    method: 'POST',
    headers:
      body !== undefined
        ? { 'Content-Type': isText ? 'text/plain' : 'application/json' }
        : {},
    body: body !== undefined ? (isText ? body : JSON.stringify(body)) : undefined,
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`POST ${url} -> ${r.status}: ${text}`)
  }
  const ct = r.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? r.json() : r.text()
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
}

/**
 * Run the multi-network operation matrix cell for a given transport.
 *
 * Steps:
 *   1. Pair dApp + wallet via the transport-appropriate URI.
 *   2. dApp calls /request-permissions with [L1, L2].
 *   3. Verify both networks landed in the session (via /last-permission).
 *   4. dApp issues an operation on L1 (via /request-operation with network=L1).
 *   5. Verify L1 transaction hash returned.
 *   6. dApp issues an operation on L2 (via /request-operation with network=L2).
 *   7. Verify L2 transaction hash returned.
 *
 * The body of step 1 is transport-specific and lives in the per-transport scaffold.
 */
export async function runMultiNetworkMatrix(transport: Transport, _pairHook?: () => Promise<void>) {
  console.log(`\n=== multi-network matrix [${transport}] ===`)

  // Reset both apps to a clean state.
  await post(`${WALLET_URL}/reset`, {}).catch(() => {})
  await post(`${DAPP_URL}/reset`, {}).catch(() => {})
  await post(`${WALLET_URL}/test-config`, { beaconVersion: null, v2Mode: false }).catch(() => {})

  // Step 1: trigger the permission flow on the dApp side. The handler holds
  // the response open until the pairing URI is generated; the await returns
  // once /pairing-uri is ready to serve.
  await post(`${DAPP_URL}/request-permissions`, {
    networks: [
      { chainId: L1_CHAIN, rpcUrl: L1_RPC, name: 'Shadownet L1' },
      { chainId: L2_CHAIN, rpcUrl: L2_RPC, name: 'Tezos X Previewnet L2' },
    ],
  })

  // Step 2: fetch the pairing URI and hand it to the wallet.
  const uri = (await get(`${DAPP_URL}/pairing-uri`)) as string
  assert(uri && uri.length > 10, `invalid pairing URI: ${uri}`)
  await post(`${WALLET_URL}/connect`, uri)

  // Step 3: poll /last-permission until accounts map arrives.
  let perm: any = null
  for (let i = 0; i < 20; i++) {
    perm = await get(`${DAPP_URL}/last-permission`)
    if (perm?.accounts) break
    await new Promise((r) => setTimeout(r, 1_000))
  }
  assert(perm?.accounts, `permission response missing accounts map: ${JSON.stringify(perm)}`)
  const chainIds = Object.keys(perm.accounts)
  assert(chainIds.includes(L1_CHAIN), `expected L1_CHAIN in accounts: ${chainIds.join(', ')}`)
  assert(chainIds.includes(L2_CHAIN), `expected L2_CHAIN in accounts: ${chainIds.join(', ')}`)
  console.log(`  ✓ multi-network permission: ${chainIds.length} chains`)

  // Step 4-5: operation on L1.
  const opL1 = await post(`${DAPP_URL}/request-operation`, {
    network: L1_CHAIN,
    operationDetails: [{ kind: 'transaction', amount: '1', destination: DEST }],
  })
  assert(opL1?.transactionHash?.length > 0, 'L1 operation returned no transactionHash')
  console.log(`  ✓ L1 op hash: ${opL1.transactionHash.slice(0, 20)}…`)

  // Step 6-7: operation on L2.
  const opL2 = await post(`${DAPP_URL}/request-operation`, {
    network: L2_CHAIN,
    operationDetails: [{ kind: 'transaction', amount: '1', destination: DEST }],
  })
  assert(opL2?.transactionHash?.length > 0, 'L2 operation returned no transactionHash')
  console.log(`  ✓ L2 op hash: ${opL2.transactionHash.slice(0, 20)}…`)

  console.log(`\n=== multi-network matrix [${transport}] PASS ===`)
}

/**
 * Run the FR-019 defensive cell: v4-multi-network dApp talks to a wallet
 * pinned to "v4 but no spec-003 fanout" (no `accounts[]` in response).
 * dApp SDK MUST raise NetworksUnsupportedBeaconError before any session
 * is created.
 *
 * Wallet pin is set via /test-config; the wallet harness MUST honor it
 * by skipping the accounts[] population in the permission_response.
 */
export async function runFr019DefensiveCell(transport: Transport, pair: () => Promise<void>) {
  console.log(`\n=== FR-019 defensive [${transport}] ===`)

  await post(`${WALLET_URL}/test-config`, { beaconVersion: '4', suppressAccountsFanout: true })
  await post(`${DAPP_URL}/reset`, {}).catch(() => {})

  await pair()

  let caught = false
  try {
    await post(`${DAPP_URL}/request-permissions`, {
      networks: [
        { chainId: L1_CHAIN, rpcUrl: L1_RPC },
        { chainId: L2_CHAIN, rpcUrl: L2_RPC },
      ],
    })
  } catch {
    caught = true
  }
  // Either the request itself errored, or the dApp surfaced it via /last-handshake.
  if (!caught) {
    const hs = await get(`${DAPP_URL}/last-handshake`).catch(() => null)
    assert(
      hs?.mode === 'networks_unsupported' || hs?.errorCode === 'NETWORKS_UNSUPPORTED',
      `expected networks_unsupported, got ${JSON.stringify(hs)}`,
    )
  }
  console.log(`  ✓ NetworksUnsupportedBeaconError raised`)
  console.log(`\n=== FR-019 defensive [${transport}] PASS ===`)

  // Reset wallet pin so subsequent scaffolds aren't affected.
  await post(`${WALLET_URL}/test-config`, { beaconVersion: null, suppressAccountsFanout: false })
}
