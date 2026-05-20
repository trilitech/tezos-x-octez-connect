/**
 * Spec 002-peer-version-handshake, T021 (US2) — Matrix P2P.
 *
 * dApp-side detection matrix:
 *   A. v4 dApp × v4 wallet → multi-network path, no error
 *   B. v4 dApp × v3 wallet (unupgraded) → SDK raises VersionUnsupportedBeaconError
 *
 * Run: tsx test/phase-version-negotiation/dapp-detection-matrix-p2p.ts
 */
import { runScenario, assert } from './_shared'

;(async () => {
  await runScenario(
    'A. v4 dApp × v4 wallet — happy path',
    'matrix',
    'upgraded',
    'upgraded',
    (o) => {
      assert(o.errorCode === null, `unexpected error: ${o.errorCode}`)
      assert(o.mode === 'multi-network', `expected multi-network, got ${o.mode}`)
    },
  )

  await runScenario(
    'B. v4 dApp × unupgraded wallet — SDK throws VersionUnsupportedBeaconError',
    'matrix',
    'unupgraded',
    'upgraded',
    (o) => {
      assert(o.errorCode === 'VERSION_UNSUPPORTED',
        `expected VERSION_UNSUPPORTED, got ${o.errorCode}`)
      assert(o.requiredMinimumVersion === '4',
        `expected requiredMinimumVersion '4', got ${o.requiredMinimumVersion}`)
      assert(o.walletServedVersion === '3',
        `expected walletServedVersion '3', got ${o.walletServedVersion}`)
    },
  )

  console.log('\nAll dapp-detection scenarios (Matrix P2P) passed.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
