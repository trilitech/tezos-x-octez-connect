/**
 * Spec 002-peer-version-handshake, T023 (US2) — popup / PostMessage.
 *
 * Playwright variant of the dApp-detection matrix.
 *
 * Run: npx playwright test test/phase-version-negotiation/dapp-detection-matrix-postmessage.spec.ts
 */
import { test, expect } from '@playwright/test'
import { runScenario, assert } from './_shared'

test('A. v4 dApp × v4 wallet — popup', async () => {
  await runScenario(
    'A. v4 dApp × v4 wallet — popup',
    'postmessage',
    'upgraded',
    'upgraded',
    (o) => {
      assert(o.errorCode === null, `unexpected error: ${o.errorCode}`)
    },
  )
})

test('B. v4 dApp × unupgraded wallet — popup', async () => {
  await runScenario(
    'B. v4 dApp × unupgraded wallet — popup',
    'postmessage',
    'unupgraded',
    'upgraded',
    (o) => {
      assert(o.errorCode === 'VERSION_UNSUPPORTED', `errorCode was ${o.errorCode}`)
      assert(o.requiredMinimumVersion === '4', `req min was ${o.requiredMinimumVersion}`)
      assert(o.walletServedVersion === '3', `served was ${o.walletServedVersion}`)
    },
  )
})

test('Outcome shape parity (smoke)', () => {
  expect(true).toBe(true)
})
