/**
 * Spec 002-peer-version-handshake, T010 (US1) — Matrix P2P transport.
 *
 * Wallet routing matrix: confirms the wallet single-branches on
 * peer.version and routes legacy + new dApps to their correct handlers.
 *
 * Cells (driven from the dApp side):
 *   A. dApp peer.version='4' × upgraded wallet → multi-network path
 *   C. dApp peer.version='3' (legacy) × upgraded wallet → legacy path
 *
 * (Cell B — unupgraded wallet — is covered by the dApp-detection scaffold
 * since it's a dApp-SDK-side check, not a wallet-routing assertion.)
 *
 * Run: tsx test/phase-version-negotiation/wallet-routing-matrix-p2p.ts
 */
import { runScenario, assert } from './_shared'

;(async () => {
  await runScenario(
    'A. v4 dApp × v4 wallet (multi-network)',
    'matrix',
    'upgraded',
    'upgraded',
    (o) => {
      assert(o.mode === 'multi-network', `expected multi-network, got ${o.mode}`)
      assert(o.walletServedVersion === '4', `expected '4', got ${o.walletServedVersion}`)
      assert(o.errorCode === null, `unexpected error: ${o.errorCode}`)
    },
  )

  await runScenario(
    'C. legacy dApp × v4 wallet (backward-compat)',
    'matrix',
    'upgraded',
    'legacy',
    (o) => {
      assert(o.mode === 'legacy', `expected legacy, got ${o.mode}`)
      assert(o.errorCode === null, `unexpected error: ${o.errorCode}`)
    },
  )

  console.log('\nAll wallet-routing-matrix scenarios (Matrix P2P) passed.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
