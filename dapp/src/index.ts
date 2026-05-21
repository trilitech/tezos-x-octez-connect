// Polyfill browser globals for Node.js
// (SDK accesses window.indexedDB, window.addEventListener, localStorage, BroadcastChannel)
import 'fake-indexeddb/auto'

if (typeof localStorage === 'undefined') {
  const _store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => _store.get(k) ?? null,
    setItem: (k: string, v: string) => _store.set(k, String(v)),
    removeItem: (k: string) => _store.delete(k),
    clear: () => _store.clear(),
    key: (i: number) => [..._store.keys()][i] ?? null,
    get length() { return _store.size },
  }
}

if (typeof window === 'undefined') {
  const _listeners: Record<string, Array<(...args: any[]) => void>> = {}
  ;(globalThis as any).window = {
    indexedDB: (globalThis as any).indexedDB,
    localStorage: (globalThis as any).localStorage,
    navigator: { userAgent: 'node.js' },
    addEventListener: (type: string, cb: (...args: any[]) => void) => {
      ;(_listeners[type] ??= []).push(cb)
    },
    removeEventListener: (type: string, cb: (...args: any[]) => void) => {
      _listeners[type] = (_listeners[type] ?? []).filter((l) => l !== cb)
    },
    matchMedia: (_query: string) => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    location: { href: 'http://localhost/' },
    open: () => null,
  }
}

if (typeof BroadcastChannel === 'undefined') {
  ;(globalThis as any).BroadcastChannel = class {
    constructor(_name: string) {}
    postMessage(_data: unknown) {}
    addEventListener(_type: string, _cb: unknown) {}
    removeEventListener(_type: string, _cb: unknown) {}
    close() {}
  }
}

if (typeof navigator === 'undefined') {
  ;(globalThis as any).navigator = { userAgent: 'node.js' }
}

// WalletConnect calls socket.terminate() (ws-package API) on ping timeout.
// Node.js 22 native WebSocket has no terminate() — polyfill it with close().
if (typeof WebSocket !== 'undefined' && !('terminate' in WebSocket.prototype)) {
  ;(WebSocket.prototype as any).terminate = function () { this.close() }
}

// Suppress expected SDK-internal crashes so the Express server stays alive across resets.
// The "unload" library (used by both octez.connect and walletconnect) registers an
// uncaughtException handler that calls process.exit(101) for ANY error. It does this
// asynchronously (after the BroadcastChannel leader election completes), so
// process.removeAllListeners() here may run before unload re-registers. Block exit(101) instead.
const _origExit = process.exit.bind(process)
;(process as any).exit = (code?: number | string) => {
  if (code === 101) {
    console.error('[dapp] suppressed process.exit(101) from unload library')
    return
  }
  return _origExit(code as number)
}

const SUPPRESSED_ERRORS = [
  'Syncing stopped manually.',  // Matrix sync stopped on client.destroy()
  'Proposal expired',           // WalletConnect proposal TTL exceeded on reconnect
]

function isSuppressed(err: any): boolean {
  return SUPPRESSED_ERRORS.some((m) => err?.message?.includes(m))
}

// Remove any early-registered unload handlers and install our own.
process.removeAllListeners('uncaughtException')
process.removeAllListeners('unhandledRejection')

process.on('uncaughtException', (err: any) => {
  if (isSuppressed(err)) return
  console.error('[dapp] uncaughtException:', err)
  _origExit(1)
})

process.on('unhandledRejection', (reason: any) => {
  if (isSuppressed(reason)) return
  console.error('[dapp] unhandledRejection:', reason)
})

import express from 'express'
import {
  DAppClient,
  NetworkType,
  BeaconEvent,
  Regions,
} from '@tezos-x/octez.connect-dapp'
import { WCStorage } from '@tezos-x/octez.connect-core'
import { MemoryStorage } from './storage'

const PORT = parseInt(process.env.PORT ?? '5173')
const L1_RPC = 'https://rpc.shadownet.teztnets.com'
const L2_RPC = 'https://michelson.previewnet.tezosx.nomadic-labs.com'

// ── State ──────────────────────────────────────────────────────────────────

let pairingUri: string | null = null
let pairingUriWaiters: Array<() => void> = []
let lastPermission: unknown = null
let lastOp: { transactionHash: string } | null = null
let lastHandshake: { mode: string; [k: string]: any } = { mode: 'pending' }

// ── Client factory ─────────────────────────────────────────────────────────

/**
 * Spec 002-peer-version-handshake test-harness override.
 * When set, the DAppClient is constructed with an explicit
 * `requiredMinimumVersion`. Pinning it to '3' simulates a "legacy dApp"
 * (it accepts wallets at peer.version='3'+); pinning it to '5'
 * simulates the synthetic future-version test for US3.
 */
let testRequiredMinimumVersion: string | undefined =
  process.env.REQUIRED_MIN_VERSION ?? undefined

function createClient(): DAppClient {
  const client = new DAppClient({
    name: 'Tezos X dApp POC',
    disableDefaultEvents: true,
    storage: new MemoryStorage() as any,
    network: {
      type: NetworkType.CUSTOM,
      rpcUrl: L1_RPC,
      name: 'Shadownet L1',
    },
    matrixNodes: {
      [Regions.EUROPE_WEST]: [
        'beacon-node-1.octez.io',
        'beacon-node-2.octez.io',
        'beacon-node-3.octez.io',
      ],
    },
    ...(testRequiredMinimumVersion
      ? ({ requiredMinimumVersion: testRequiredMinimumVersion } as any)
      : {}),
  })

  // Capture pairing URI as soon as it is generated (before any modal would show)
  client.subscribeToEvent(BeaconEvent.PAIR_INIT, async (data: any) => {
    console.log('[dapp] PAIR_INIT received')
    try {
      const uri: string = await data.p2pPeerInfo
      console.log(`[dapp] PAIR_INIT p2pPeerInfo resolved: ${uri ? uri.slice(0, 40) + '…' : '(empty)'}`)
      pairingUri = uri
      for (const resolve of pairingUriWaiters) resolve()
      pairingUriWaiters = []
    } catch (err) {
      console.error('[dapp] PAIR_INIT p2pPeerInfo error:', err)
      // Propagate failure so /request-permissions doesn't hang indefinitely
      const waiters = pairingUriWaiters
      pairingUriWaiters = []
      for (const resolve of waiters) resolve()
    }
  })

  return client
}

let client: DAppClient = createClient()
let _pendingPermission: Promise<void> | null = null

// ── Express server ─────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use((req, _res, next) => { console.log(`[dapp] ${req.method} ${req.path}`); next() })

// POST /request-permissions
// No body → legacy single-network flow (Phase 1).
// {networks:[...]} → multi-network flow (Phase 2), routed by peer.version='4'.
// Returns 200 once the pairing URI is ready — does NOT wait for wallet approval.
app.post('/request-permissions', async (req, res) => {
  pairingUri = null
  pairingUriWaiters = []

  const { networks } = (req.body ?? {}) as { networks?: any[] }

  // Spec 002-peer-version-handshake: the SDK accepts `networks` as a
  // first-class option, stamps peer.version='4' automatically (via
  // BEACON_VERSION), and the dApp-side SDK raises
  // VersionUnsupportedBeaconError when the wallet hasn't been upgraded.
  // No makeRequest monkey-patching needed.
  _pendingPermission = (
    client.requestPermissions(networks?.length ? { networks } : undefined) as any
  )
    .then(async (perm: any) => {
      // Look up the wallet's served peer.version from the SDK's PeerManager
      // for inclusion in last-handshake (the spec 002 negotiation outcome).
      let walletServedVersion: string | undefined
      try {
        const walletPeer = await (client as any).getPeer?.()
        walletServedVersion = (walletPeer as any)?.version
      } catch (_e) {}

      if (perm?.accounts && typeof perm.accounts === 'object') {
        // Upgraded wallet served the multi-network shape.
        lastPermission = { version: walletServedVersion ?? '4', accounts: perm.accounts }
        lastHandshake = {
          mode: 'multi-network',
          walletServedVersion: walletServedVersion ?? '4',
        }
      } else {
        // Legacy single-network response (peer.version = '3', wallet
        // ignored the networks[] option). Only possible if the dApp's
        // requiredMinimumVersion is set <= '3'.
        lastPermission = { version: walletServedVersion ?? '3', publicKey: perm.publicKey, address: perm.address }
        lastHandshake = {
          mode: 'legacy',
          walletServedVersion: walletServedVersion ?? '3',
        }
      }
    })
    .catch((err: any) => {
      // VersionUnsupportedBeaconError lands here when the wallet hasn't
      // been upgraded and the dApp's requiredMinimumVersion is '4'.
      console.error('[dapp] requestPermissions error:', err.message)
      if (err?.errorCode === 'VERSION_UNSUPPORTED') {
        lastHandshake = {
          mode: 'version_unsupported',
          requiredMinimumVersion: err.requiredMinimumVersion,
          walletServedVersion: err.walletServedVersion,
        }
      }
    })

  // Wait until pairing URI is available before responding to test runner
  if (!pairingUri) {
    await new Promise<void>((resolve) => pairingUriWaiters.push(resolve))
  }

  res.sendStatus(200)
})

// GET /pairing-uri
app.get('/pairing-uri', (_req, res) => {
  if (!pairingUri) return res.status(404).json({ error: 'no pairing URI yet' })
  res.type('text/plain').send(pairingUri)
})

// POST /request-operation
// Body: { network?: string (CAIP-2), operationDetails: PartialTezosOperation[] }
// network present → multi-network routing on the upgraded wallet.
app.post('/request-operation', async (req, res) => {
  try {
    const { operationDetails, network } = req.body

    // Spec 003 multi-network protocol: per-call network selection is now a
    // first-class option on requestOperation. The previous makeRequest
    // monkey-patch has been removed.
    const result = await client.requestOperation({
      operationDetails,
      ...(network ? { network } : {}),
    })
    lastOp = { transactionHash: result.transactionHash }
    res.json(lastOp)
  } catch (err: any) {
    console.error('[dapp] requestOperation error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /last-permission
app.get('/last-permission', (_req, res) => {
  res.json(lastPermission)
})

// GET /last-handshake
app.get('/last-handshake', (_req, res) => {
  res.json(lastHandshake)
})

// GET /last-op
app.get('/last-op', (_req, res) => {
  res.json(lastOp)
})

/**
 * POST /test-config — spec 002-peer-version-handshake harness control.
 *
 * Body: { requiredMinimumVersion?: string | null }
 *
 * Sets the `requiredMinimumVersion` option that future `DAppClient`
 * constructions will use. To apply, follow with `POST /reset` (which
 * destroys and recreates the client). Pass `null` to clear the
 * override and revert to the SDK default (= BEACON_VERSION).
 */
app.post('/test-config', (req, res) => {
  const body = (req.body ?? {}) as any
  if (body.requiredMinimumVersion === null || body.requiredMinimumVersion === undefined) {
    testRequiredMinimumVersion = undefined
  } else {
    const v = String(body.requiredMinimumVersion)
    if (!/^\d+$/.test(v)) {
      res.status(400).json({ error: 'requiredMinimumVersion must be a decimal-integer string' })
      return
    }
    testRequiredMinimumVersion = v
  }
  res.json({
    requiredMinimumVersion: testRequiredMinimumVersion ?? null,
    note: 'follow with POST /reset to recreate the DAppClient with the new option',
  })
})

// POST /reset
app.post('/reset', async (_req, res) => {
  pairingUri = null
  pairingUriWaiters = []
  lastPermission = null
  lastOp = null
  lastHandshake = { mode: 'pending' }
  _pendingPermission = null
  // WalletConnectCommunicationClient is a static singleton shared across all DAppClient
  // instances. Close its SignClient (stops the relay connection) and reset the singleton
  // reference so the next DAppClient gets a fresh WC communication client.
  const wcCommClient = (client as any).walletConnectTransport?.client
  if (wcCommClient) {
    try { await wcCommClient.closeSignClient() } catch (_e) {}
    try { wcCommClient.constructor.instance = undefined } catch (_e) {}
  }
  // Close the MultiTabChannel (elector + BroadcastChannel) before destroying the client.
  // The SDK's destroy() does not call elector.die() or channel.close(), so the old elector
  // keeps its 'isLeaderListener' registered on the underlying BroadcastChannel. In Node.js
  // 22 the native BroadcastChannel is used (not the no-op polyfill — because BroadcastChannel
  // is globally defined in Node 15+, so the `typeof BroadcastChannel === 'undefined'` guard
  // in this file never fires). Same-name channels share a real message bus, so the old
  // elector receives the new elector's 'apply' message and replies with 'tell', making the
  // new elector believe another leader exists — causing an infinite fallback loop.
  // Closing the channel triggers its _befC callbacks, which includes elector.die(), cleanly
  // removing the isLeaderListener and sending a 'death' message so others know to re-elect.
  try {
    const mtc = (client as any).multiTabChannel
    if (mtc?.channel) await mtc.channel.close()
  } catch (_e) {}
  try {
    await (client as any).destroy()
  } catch (_e) {}
  // Clear WalletConnect's shared global storage (IndexedDB + localStorage).
  try {
    await new WCStorage().resetState()
  } catch (_e) {}
  try {
    client = createClient()
    lastHandshake = { mode: 'pending' }
    res.sendStatus(200)
  } catch (err: any) {
    // createClient() throws when requiredMinimumVersion > BEACON_VERSION
    // (spec 002, InvalidRequiredMinimumVersionError). Record the
    // construction error in last-handshake so test scaffolds can see
    // it, and reply 200 — the test asserts on the error structure,
    // not on a 500 status.
    lastHandshake = {
      mode: 'construction_error',
      errorCode: err?.errorCode ?? 'CONSTRUCTION_FAILED',
      requiredMinimumVersion: err?.providedValue,
      sdkBeaconVersion: err?.sdkBeaconVersion,
      message: err?.message,
    }
    console.error('[dapp] createClient error:', err.message)
    res.sendStatus(200)
  }
})

app.listen(PORT, () => console.log(`[dapp] listening on :${PORT}`))
