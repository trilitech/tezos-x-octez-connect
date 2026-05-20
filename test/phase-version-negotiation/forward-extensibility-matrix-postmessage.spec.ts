/**
 * Forward-extensibility, popup/PostMessage transport (T034).
 *
 * Mirrors the Matrix and WC2 scaffolds. The SDK's construction-time
 * enforcement of `requiredMinimumVersion <= BEACON_VERSION` is checked.
 *
 * Run: npx playwright test test/phase-version-negotiation/forward-extensibility-matrix-postmessage.spec.ts
 */
import { test, expect } from '@playwright/test'
import { DAPP_URL, WALLET_URL, get, post, assert } from './_shared'

test('Forward-extensibility: v5 dApp construction-time error (popup)', async () => {
  await post(`${DAPP_URL}/test-config`, { requiredMinimumVersion: '5' })
  await post(`${DAPP_URL}/reset`)
  await post(`${WALLET_URL}/reset`).catch(() => {})

  const handshake: any = await get(`${DAPP_URL}/last-handshake`)
  assert(handshake?.mode === 'construction_error', `mode was ${handshake?.mode}`)
  assert(handshake?.errorCode === 'INVALID_REQUIRED_MINIMUM_VERSION',
    `errorCode was ${handshake?.errorCode}`)
  assert(handshake?.requiredMinimumVersion === '5', `req was ${handshake?.requiredMinimumVersion}`)
  assert(handshake?.sdkBeaconVersion === '4', `sdk was ${handshake?.sdkBeaconVersion}`)

  // Cleanup
  await post(`${DAPP_URL}/test-config`, { requiredMinimumVersion: null })
  await post(`${DAPP_URL}/reset`)

  expect(true).toBe(true)
})
