/**
 * Shared helpers for spec 002-peer-version-handshake e2e tests.
 *
 * Three transports × three negotiation cells = 9 scaffolds. Each
 * scaffold consumes these helpers and drives the dApp/wallet pair
 * exposed via HTTP control endpoints (the same convention used by
 * phase1.ts / phase2.ts).
 *
 * Prerequisites for any of these tests to actually pass:
 *   - The reference dApp and wallet are running (e.g. `dapp/`, `wallet/`).
 *   - WALLET_SK is exported (constitution Principle III: real-network).
 *   - The local clone of octez.connect is npm-linked into the dApp/wallet
 *     so the SDK code under test is the demo branch's, not a stale
 *     node_modules copy. See specs/002-peer-version-handshake/demo-branch.md.
 *   - For the "unupgraded wallet" cells, the wallet harness is launched
 *     with BEACON_VERSION pinned to '3' via the OVERRIDE_BEACON_VERSION
 *     env var the harness reads.
 *
 * These scaffolds are intentionally network-shape-only assertions; the
 * actual ghostnet operation that follows successful negotiation is
 * covered by phase2.ts / phase5.ts and not re-run here.
 */

export const DAPP_URL = process.env.DAPP_URL ?? 'http://localhost:5173'
export const WALLET_URL = process.env.WALLET_URL ?? 'http://localhost:5174'
export const L1_CHAIN = 'tezos:NetXsqzbfFenSTS'
export const L2_CHAIN = 'tezos:NetXH12Aer3be93'
export const L1_RPC = 'https://rpc.shadownet.teztnets.com'
export const L2_RPC = 'https://demo.txpark.nomadic-labs.com/rpc/tezlink'

export type Transport = 'matrix' | 'walletconnect' | 'postmessage'
export type WalletMode = 'upgraded' | 'unupgraded'
export type DappMode = 'upgraded' | 'legacy' | 'future-v5'

export interface NegotiationOutcome {
  // Wire-layer wallet response version (string, e.g. '3' or '4').
  walletServedVersion: string | null
  // dApp-SDK-side error code, if SDK raised. 'VERSION_UNSUPPORTED' is the
  // success signal for the "unupgraded wallet" cells.
  errorCode: string | null
  // dApp's resolved required-minimum, if surfaced (only on errors).
  requiredMinimumVersion: string | null
  // High-level mode reported by the dApp harness.
  mode: string
}

export async function get(url: string): Promise<any> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`)
  return r.json()
}

export async function post(url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`POST ${url} -> ${r.status}: ${text}`)
  }
  const ct = r.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? r.json() : r.text()
}

/**
 * Configure the wallet harness for this test cell. Both the transport
 * and the "is the wallet upgraded?" choice are set via control
 * endpoints exposed by the wallet harness for testing only.
 */
export async function configureWallet(transport: Transport, mode: WalletMode): Promise<void> {
  await post(`${WALLET_URL}/test-config`, {
    transport,
    beaconVersion: mode === 'upgraded' ? '4' : '3',
  })
}

/**
 * Configure the dApp harness similarly. `dappMode` translates to a
 * specific BEACON_VERSION pin (and therefore default
 * requiredMinimumVersion) on the dApp SDK.
 */
export async function configureDapp(transport: Transport, mode: DappMode): Promise<void> {
  const beaconVersion =
    mode === 'upgraded' ? '4' : mode === 'legacy' ? '3' : '5'
  await post(`${DAPP_URL}/test-config`, { transport, beaconVersion })
}

/**
 * Drive a full permission handshake and collect the resulting state.
 * The dApp harness must expose:
 *   POST /request-permissions  body: { networks?: [...] }
 *   GET  /last-handshake       -> { mode, walletServedVersion?, ... }
 *   GET  /last-permission      -> { version, ... }
 */
export async function handshake(
  options: { networks?: any[] } = {},
): Promise<NegotiationOutcome> {
  await post(`${DAPP_URL}/request-permissions`, options)

  // Poll for completion — the dApp resolves asynchronously after the
  // wallet approves (or the SDK throws VersionUnsupportedBeaconError).
  for (let i = 0; i < 60; i++) {
    const h = await get(`${DAPP_URL}/last-handshake`)
    if (h && h.mode && h.mode !== 'pending') {
      return {
        walletServedVersion: h.walletServedVersion ?? null,
        errorCode:
          h.mode === 'version_unsupported' ? 'VERSION_UNSUPPORTED' : null,
        requiredMinimumVersion: h.requiredMinimumVersion ?? null,
        mode: h.mode,
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Handshake did not complete on dApp side within 60s`)
}

export function assert(cond: any, message: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${message}`)
}

export async function runScenario(
  label: string,
  transport: Transport,
  walletMode: WalletMode,
  dappMode: DappMode,
  expect: (outcome: NegotiationOutcome) => void,
): Promise<void> {
  console.log(`\n=== ${label} (${transport}, wallet=${walletMode}, dapp=${dappMode}) ===`)
  await configureWallet(transport, walletMode)
  await configureDapp(transport, dappMode)
  const outcome = await handshake({
    networks:
      dappMode === 'legacy'
        ? undefined
        : [
            { chainId: L1_CHAIN, rpcUrl: L1_RPC, name: 'Shadownet L1' },
            { chainId: L2_CHAIN, rpcUrl: L2_RPC, name: 'Michelson interface' },
          ],
  })
  console.log(`  outcome:`, outcome)
  expect(outcome)
  console.log(`  PASS`)
}
