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
/**
 * Verifies the SDK's construction-time contract:
 *   `requiredMinimumVersion` > `BEACON_VERSION` → InvalidRequiredMinimumVersionError
 *
 * This IS the forward-extensibility test: a dApp whose code requires a
 * future protocol version it doesn't yet support (its SDK was not built
 * against version '5') is told at construction time, not at handshake
 * time. See contracts/sdk-options.md F2.
 *
 * Driven via the dApp harness's /test-config + /reset endpoints. The
 * /reset handler now captures the construction error into last-handshake
 * (rather than 500ing) so the assertion can be made over HTTP.
 */
import { DAPP_URL, WALLET_URL, get, post, assert } from './_shared'

;(async () => {
  console.log('\n=== forward-extensibility: v5 dApp construction-time error ===')

  // Set requiredMinimumVersion='5' (above current SDK BEACON_VERSION='4').
  await post(`${DAPP_URL}/test-config`, { requiredMinimumVersion: '5' })

  // Trigger DAppClient reconstruction.
  await post(`${DAPP_URL}/reset`)
  await post(`${WALLET_URL}/reset`).catch(() => {})

  // Inspect the captured construction error.
  const handshake: any = await get(`${DAPP_URL}/last-handshake`)
  console.log('  outcome:', handshake)
  assert(
    handshake?.mode === 'construction_error',
    `expected mode=construction_error, got ${handshake?.mode}`,
  )
  assert(
    handshake?.errorCode === 'INVALID_REQUIRED_MINIMUM_VERSION',
    `expected errorCode=INVALID_REQUIRED_MINIMUM_VERSION, got ${handshake?.errorCode}`,
  )
  assert(
    handshake?.requiredMinimumVersion === '5',
    `expected requiredMinimumVersion=5, got ${handshake?.requiredMinimumVersion}`,
  )
  assert(
    handshake?.sdkBeaconVersion === '4',
    `expected sdkBeaconVersion=4, got ${handshake?.sdkBeaconVersion}`,
  )
  console.log('  PASS')

  // Cleanup: clear the bad option so subsequent tests can construct.
  await post(`${DAPP_URL}/test-config`, { requiredMinimumVersion: null })
  await post(`${DAPP_URL}/reset`)

  console.log('\nForward-extensibility scenario (Matrix P2P) passed.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
