/**
 * Spec 003-multi-network-protocol T020 — postMessage / popup transport (Playwright).
 *
 * Drives the v4-multi-network × v4-multi-network matrix cell over the
 * tzip10-popup transport. Uses Playwright to open the dApp and wallet
 * pages and let the popup-pairing flow complete in-browser.
 *
 * Run via Playwright: npx playwright test test/phase-multi-network/multi-network-operation-postmessage.spec.ts
 *
 * Prereqs: dapp + wallet served on http localhosts; WALLET_SK exported;
 * SDK linked locally; the wallet popup page reachable.
 */
import { test, expect } from '@playwright/test'
import { DAPP_URL, L1_CHAIN, L2_CHAIN, L1_RPC, L2_RPC, DEST } from './_shared'

test('multi-network operation matrix (postMessage popup)', async ({ page }) => {
  await page.goto(DAPP_URL + '/')

  // Trigger permission request from the dApp page.
  await page.evaluate(
    ({ L1, L2, L1R, L2R }) => {
      ;(window as any).__triggerPermissions({
        networks: [
          { chainId: L1, rpcUrl: L1R, name: 'Shadownet L1' },
          { chainId: L2, rpcUrl: L2R, name: 'Tezos X Previewnet L2' },
        ],
      })
    },
    { L1: L1_CHAIN, L2: L2_CHAIN, L1R: L1_RPC, L2R: L2_RPC },
  )

  // Wait for the popup to drive the pairing and the dApp to materialize accounts.
  await page.waitForSelector('[data-account-chain="' + L1_CHAIN + '"]', { timeout: 30_000 })
  await page.waitForSelector('[data-account-chain="' + L2_CHAIN + '"]', { timeout: 30_000 })

  const chains = await page.locator('[data-account-chain]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-account-chain')),
  )
  expect(chains).toContain(L1_CHAIN)
  expect(chains).toContain(L2_CHAIN)

  // L1 operation.
  const l1Hash = await page.evaluate(
    ({ L1, dest }) => (window as any).__requestOp({ network: L1, dest }),
    { L1: L1_CHAIN, dest: DEST },
  )
  expect(l1Hash).toBeTruthy()

  // L2 operation.
  const l2Hash = await page.evaluate(
    ({ L2, dest }) => (window as any).__requestOp({ network: L2, dest }),
    { L2: L2_CHAIN, dest: DEST },
  )
  expect(l2Hash).toBeTruthy()
})
