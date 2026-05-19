/**
 * Forward-extensibility, WC2 transport (T033).
 *
 * The SDK's construction-time enforcement of
 * `requiredMinimumVersion <= BEACON_VERSION` is transport-agnostic —
 * DAppClient throws InvalidRequiredMinimumVersionError before any
 * transport is even selected. Re-running the same test under the WC2
 * scaffold verifies the contract is consistent across transports.
 *
 * Run: tsx test/phase-version-negotiation/forward-extensibility-matrix-walletconnect.ts
 */
import { DAPP_URL, WALLET_URL, get, post, assert } from './_shared'

;(async () => {
  console.log('\n=== forward-extensibility (WC2): v5 dApp construction-time error ===')

  await post(`${DAPP_URL}/test-config`, { requiredMinimumVersion: '5' })
  await post(`${DAPP_URL}/reset`)
  await post(`${WALLET_URL}/reset`).catch(() => {})

  const handshake: any = await get(`${DAPP_URL}/last-handshake`)
  console.log('  outcome:', handshake)
  assert(handshake?.mode === 'construction_error', `mode was ${handshake?.mode}`)
  assert(handshake?.errorCode === 'INVALID_REQUIRED_MINIMUM_VERSION',
    `errorCode was ${handshake?.errorCode}`)
  assert(handshake?.requiredMinimumVersion === '5',
    `requiredMinimumVersion was ${handshake?.requiredMinimumVersion}`)
  assert(handshake?.sdkBeaconVersion === '4',
    `sdkBeaconVersion was ${handshake?.sdkBeaconVersion}`)
  console.log('  PASS')

  await post(`${DAPP_URL}/test-config`, { requiredMinimumVersion: null })
  await post(`${DAPP_URL}/reset`)

  console.log('\nForward-extensibility scenario (WC2) passed.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
