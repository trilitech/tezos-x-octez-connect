/**
 * Spec 003-multi-network-protocol T021 — FR-019 defensive cell.
 *
 * Pins the wallet to a "v4 but no spec-003 fanout" mode via /test-config:
 * the wallet responds with peer.version='4' but omits the accounts[]
 * CAIP-2-keyed map. The dApp SDK MUST detect the shape mismatch and raise
 * NetworksUnsupportedBeaconError before any session is materialized.
 *
 * Reuses the existing spec 002 /test-config endpoint on the wallet harness.
 * Adds a new sub-flag `suppressAccountsFanout: boolean` that the wallet's
 * v4 permission-handler branch reads to skip its multi-network response
 * shape. (Wallet-side wiring of this flag is part of T021; the assertion
 * lives here.)
 *
 * Run: tsx test/phase-multi-network/multi-network-fr019-defensive.ts
 */
import { runFr019DefensiveCell, post, WALLET_URL, DAPP_URL, get } from './_shared'

async function pairP2P() {
  const uri = (await get(`${DAPP_URL}/pairing-uri`)) as string
  if (!uri || uri.length < 10) throw new Error(`invalid pairing URI: ${uri}`)
  await post(`${WALLET_URL}/connect`, uri)
  await new Promise((r) => setTimeout(r, 2_000))
}

;(async () => {
  await runFr019DefensiveCell('matrix', pairP2P)
  console.log('\nT021 multi-network-fr019-defensive PASS.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
