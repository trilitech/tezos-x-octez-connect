/**
 * Spec 002-peer-version-handshake, T032 (US3) — Matrix P2P.
 *
 * Forward-extensibility: a synthetic dApp pinned to BEACON_VERSION='5'
 * talks to a wallet still at '4'. The wallet must serve at its own max
 * ('4'); the dApp-side SDK must raise VersionUnsupportedBeaconError
 * with requiredMinimumVersion='5'.
 *
 * Critically, this test MUST pass WITHOUT any wallet-side code change
 * relative to T010 — the routing handles future-version dApps via the
 * same single-branch logic.
 *
 * Run: tsx test/phase-version-negotiation/forward-extensibility-matrix-p2p.ts
 */
import { runScenario, assert } from './_shared'

;(async () => {
  await runScenario(
    'v5 dApp × v4 wallet — wallet serves at own max',
    'matrix',
    'upgraded',
    'future-v5',
    (o) => {
      assert(o.errorCode === 'VERSION_UNSUPPORTED',
        `expected VERSION_UNSUPPORTED, got ${o.errorCode}`)
      assert(o.walletServedVersion === '4',
        `wallet should serve '4' (its max), got ${o.walletServedVersion}`)
      assert(o.requiredMinimumVersion === '5',
        `dApp min should be '5', got ${o.requiredMinimumVersion}`)
    },
  )

  console.log('\nForward-extensibility scenario (Matrix P2P) passed.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
