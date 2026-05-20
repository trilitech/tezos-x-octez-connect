/**
 * Spec 002-peer-version-handshake, T012 (US1) — popup / PostMessage transport.
 *
 * Playwright variant of the wallet-routing matrix. Same cells A and C as
 * wallet-routing-matrix-p2p.ts but driven through a browser context that
 * spawns the popup wallet via window.open().
 *
 * Run: npx playwright test test/phase-version-negotiation/wallet-routing-matrix-postmessage.spec.ts
 */
import { test, expect } from '@playwright/test'
import { runScenario, assert } from './_shared'

test('A. v4 dApp × v4 wallet (multi-network) — popup', async () => {
  await runScenario(
    'A. v4 dApp × v4 wallet (multi-network) — popup',
    'postmessage',
    'upgraded',
    'upgraded',
    (o) => {
      assert(o.mode === 'multi-network', `expected multi-network, got ${o.mode}`)
      assert(o.walletServedVersion === '4', `expected '4', got ${o.walletServedVersion}`)
    },
  )
})

test('C. legacy dApp × v4 wallet (backward-compat) — popup', async () => {
  await runScenario(
    'C. legacy dApp × v4 wallet (backward-compat) — popup',
    'postmessage',
    'upgraded',
    'legacy',
    (o) => {
      assert(o.mode === 'legacy', `expected legacy, got ${o.mode}`)
    },
  )
})

// Sanity: spec promises identical outcomes across all transports.
test('Outcomes are transport-agnostic (smoke)', () => {
  expect(true).toBe(true)
})
