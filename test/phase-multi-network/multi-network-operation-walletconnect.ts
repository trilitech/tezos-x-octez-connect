/**
 * Spec 003-multi-network-protocol T019 — WalletConnect v2 transport.
 *
 * Drives the v4-multi-network × v4-multi-network matrix cell over WC2.
 *
 * Run: tsx test/phase-multi-network/multi-network-operation-walletconnect.ts
 *
 * Prereqs: dapp + wallet running with WC2 enabled; WALLET_SK exported;
 * SDK linked locally. See _shared.ts.
 */
import { DAPP_URL, WALLET_URL, post, get, runMultiNetworkMatrix } from './_shared'

async function pairWC2() {
  const uri = (await get(`${DAPP_URL}/pairing-uri`)) as string
  if (!uri || uri.length < 10) throw new Error(`invalid pairing URI: ${uri}`)
  await post(`${WALLET_URL}/connect`, uri)
  await new Promise((r) => setTimeout(r, 3_000))
}

;(async () => {
  await runMultiNetworkMatrix('walletconnect', pairWC2)
  console.log('\nT019 multi-network-operation-walletconnect PASS.')
})().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
