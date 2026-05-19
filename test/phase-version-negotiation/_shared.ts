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
export const L2_CHAIN = 'tezos:NetXY2oPPzkxUW1'
export const L1_RPC = 'https://rpc.shadownet.teztnets.com'
export const L2_RPC = 'https://michelson.previewnet.tezosx.nomadic-labs.com'

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
export async function configureWallet(_transport: Transport, mode: WalletMode): Promise<void> {
  // Wallet's outgoing peer.version override. '4' = upgraded, '3' = unupgraded.
  // Pass null on 'upgraded' so previous overrides are explicitly cleared.
  await post(`${WALLET_URL}/test-config`, {
    beaconVersion: mode === 'upgraded' ? null : '3',
    v2Mode: false,
  })
}

/**
 * Force the wallet's permission handler into its legacy single-network
 * branch — used to test the wallet-side backward-compat path (the
 * cells where the dApp is "legacy"). The wallet's `v2Mode` flag
 * exists precisely for this purpose.
 */
export async function configureWalletLegacyMode(force: boolean): Promise<void> {
  await post(`${WALLET_URL}/test-config`, { v2Mode: force })
}

/**
 * Configure the dApp harness. Cells map to requiredMinimumVersion:
 *   - upgraded → '4' (default for current SDK; rejects wallets < 4)
 *   - legacy → '3' (tolerates unupgraded wallets)
 *   - future-v5 → '5' (synthetic; throws at construction since SDK BEACON_VERSION='4')
 *
 * Transport selection is wallet-startup-time today and ignored by the
 * dApp's /test-config; the scaffolds therefore only exercise the
 * transport selected by the running wallet harness (typically Matrix).
 */
export async function configureDapp(_transport: Transport, mode: DappMode): Promise<void> {
  const requiredMinimumVersion =
    mode === 'upgraded' ? '4' : mode === 'legacy' ? '3' : '5'
  await post(`${DAPP_URL}/test-config`, { requiredMinimumVersion })
}

/**
 * Drive a full permission handshake. Performs reset → request-permissions
 * → pairing-URI exchange → poll, mirroring phase2.ts's sequence.
 */
export async function handshake(
  options: { networks?: any[] } = {},
): Promise<NegotiationOutcome> {
  // Clean slate on both sides.
  await post(`${DAPP_URL}/reset`)
  await post(`${WALLET_URL}/reset`)
  await new Promise((r) => setTimeout(r, 2000))

  // Kick the dApp into pairing mode.
  await post(`${DAPP_URL}/request-permissions`, options)

  // Hand the pairing URI to the wallet.
  const uri = (await fetch(`${DAPP_URL}/pairing-uri`).then((r) => r.text())) as string
  if (!uri || uri.length < 10) {
    throw new Error(`Invalid pairing URI from dApp: ${JSON.stringify(uri)}`)
  }
  await fetch(`${WALLET_URL}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: uri,
  })

  // Poll for completion.
  for (let i = 0; i < 60; i++) {
    const h = await get(`${DAPP_URL}/last-handshake`).catch(() => null)
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
  // For "legacy dApp" cells, force the wallet into single-network mode —
  // approximates the wallet receiving a peer.version<4 dApp without
  // requiring an SDK rebuild of the dApp. The wallet's `v2Mode` flag
  // makes it serve the legacy single-network shape regardless.
  await configureWalletLegacyMode(dappMode === 'legacy')
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
