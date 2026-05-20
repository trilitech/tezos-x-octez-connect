/**
 * Spec 002-peer-version-handshake, T011 (US1) — WalletConnect v2 transport.
 *
 * Mirrors wallet-routing-matrix-p2p.ts cells A and C for WC2.
 *
 * Run: tsx test/phase-version-negotiation/wallet-routing-matrix-walletconnect.ts
 */
import { runScenario, assert } from './_shared'

;(async () => {
  await runScenario(
    'A. v4 dApp × v4 wallet (multi-network) — WC2',
    'walletconnect',
    'upgraded',
    'upgraded',
    (o) => {
      assert(o.mode === 'multi-network', `expected multi-network, got ${o.mode}`)
      assert(o.walletServedVersion === '4', `expected '4', got ${o.walletServedVersion}`)
    },
  )

  await runScenario(
    'C. legacy dApp × v4 wallet (backward-compat) — WC2',
    'walletconnect',
    'upgraded',
    'legacy',
    (o) => {
      assert(o.mode === 'legacy', `expected legacy, got ${o.mode}`)
    },
  )

  console.log('\nAll wallet-routing-matrix scenarios (WC2) passed.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
