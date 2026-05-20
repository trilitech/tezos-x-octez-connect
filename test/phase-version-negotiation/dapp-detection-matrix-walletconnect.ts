/**
 * Spec 002-peer-version-handshake, T022 (US2) — WalletConnect v2.
 *
 * Mirrors dapp-detection-matrix-p2p.ts for WC2.
 *
 * Run: tsx test/phase-version-negotiation/dapp-detection-matrix-walletconnect.ts
 */
import { runScenario, assert } from './_shared'

;(async () => {
  await runScenario(
    'A. v4 dApp × v4 wallet — WC2',
    'walletconnect',
    'upgraded',
    'upgraded',
    (o) => {
      assert(o.errorCode === null, `unexpected error: ${o.errorCode}`)
    },
  )

  await runScenario(
    'B. v4 dApp × unupgraded wallet — WC2',
    'walletconnect',
    'unupgraded',
    'upgraded',
    (o) => {
      assert(o.errorCode === 'VERSION_UNSUPPORTED',
        `expected VERSION_UNSUPPORTED, got ${o.errorCode}`)
      assert(o.requiredMinimumVersion === '4', `req min was ${o.requiredMinimumVersion}`)
      assert(o.walletServedVersion === '3', `served was ${o.walletServedVersion}`)
    },
  )

  console.log('\nAll dapp-detection scenarios (WC2) passed.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
