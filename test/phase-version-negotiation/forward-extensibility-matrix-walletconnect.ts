/**
 * Spec 002-peer-version-handshake, T033 (US3) — WalletConnect v2.
 *
 * Mirrors forward-extensibility-matrix-p2p.ts for WC2.
 *
 * Run: tsx test/phase-version-negotiation/forward-extensibility-matrix-walletconnect.ts
 */
import { runScenario, assert } from './_shared'

;(async () => {
  await runScenario(
    'v5 dApp × v4 wallet — WC2',
    'walletconnect',
    'upgraded',
    'future-v5',
    (o) => {
      assert(o.errorCode === 'VERSION_UNSUPPORTED', `errorCode was ${o.errorCode}`)
      assert(o.walletServedVersion === '4', `served ${o.walletServedVersion}`)
      assert(o.requiredMinimumVersion === '5', `req min ${o.requiredMinimumVersion}`)
    },
  )

  console.log('\nForward-extensibility scenario (WC2) passed.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
