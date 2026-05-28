// Polyfill localStorage for Node.js (Matrix transport accesses it directly)
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

import express from 'express'
import {
  WalletClient,
  BeaconMessageType,
  PermissionScope,
  Serializer,
} from '@tezos-x/octez.connect-wallet'
import { TezosToolkit } from '@taquito/taquito'
import { InMemorySigner } from '@taquito/signer'
import { MemoryStorage } from './storage'

const PORT = parseInt(process.env.PORT ?? '5174')

const WC2_PROJECT_ID = 'fb4d4407a8fe167d79bd14b5afcc7230'
const L1_CHAIN  = 'tezos:NetXsqzbfFenSTS'
const L2_CHAIN  = 'tezos:NetXY2oPPzkxUW1'
const L1_RPC    = 'https://rpc.shadownet.teztnets.com'
const L2_RPC    = 'https://michelson.previewnet.tezosx.nomadic-labs.com'

// Suppress SDK-internal crashes so the Express server stays alive.
// The "unload" library (imported by broadcast-channel which is used by octez.connect-wallet)
// registers an uncaughtException handler that calls process.exit(101) for ANY error.
// It adds this handler asynchronously (after the leader election completes), so
// process.removeAllListeners() called here runs too early to fully remove it.
//
// The most reliable fix: intercept process.exit and block code 101.
// This lets the SDK's die() cleanup run without killing the server.
const _origExit = process.exit.bind(process)
;(process as any).exit = (code?: number | string) => {
  if (code === 101) {
    console.error('[wallet] suppressed process.exit(101) from unload library')
    return
  }
  return _origExit(code as number)
}

const SUPPRESSED_ERRORS = [
  'Syncing stopped manually.',  // Matrix sync stopped on client teardown
]

function isSuppressed(err: any): boolean {
  return SUPPRESSED_ERRORS.some((m) => err?.message?.includes(m))
}

process.removeAllListeners('uncaughtException')
process.removeAllListeners('unhandledRejection')

process.on('uncaughtException', (err: any) => {
  if (isSuppressed(err)) return
  console.error('[wallet] uncaughtException:', err)
  _origExit(1)
})

process.on('unhandledRejection', (reason: any) => {
  if (isSuppressed(reason)) return
  console.error('[wallet] unhandledRejection:', reason)
})

// Dev key — fund at https://faucet.shadownet.teztnets.com before running phase1 test
const WALLET_KEY =
  process.env.WALLET_KEY ??
  'edsk3QoqBuvdamxouPhin7swCvkQNgq4jP5KZPbwWNnwdZpSpJiEbq'
const DEFAULT_RPC = 'https://rpc.shadownet.teztnets.com'

// V2_MODE=true → wallet ignores networks[] and responds in legacy v2 shape (for backward-compat test)
let v2Mode: boolean = process.env.V2_MODE === 'true'

/**
 * Spec 002-peer-version-handshake test-harness flag.
 *
 * When set (via POST /test-config or env OVERRIDE_OUTGOING_VERSION), the
 * wallet simulates an "unupgraded wallet" by mutating the incoming
 * message's `version` field BEFORE calling client.respond(). The SDK's
 * OutgoingResponseInterceptor mirrors `request.version` onto the
 * outgoing response, so a value of '3' here causes the wallet to
 * respond with peer.version='3' even when the dApp sent '4' — which
 * is exactly what the dApp-side SDK uses to detect an unupgraded
 * wallet and raise VersionUnsupportedBeaconError.
 *
 * This flag is test-only. Leave unset for normal operation.
 */
let overrideOutgoingVersion: string | null =
  process.env.OVERRIDE_OUTGOING_VERSION ?? null

// chainId (CAIP-2) → rpcUrl — populated from networks[] on permission_request
let networkRegistry: Record<string, string> = {}

let lastRpcCall: { chainId: string; rpcUrl: string } | null = null

// ── WC2 state ─────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wc2Client: any = null
let wc2Ready = false

function rpcForChain(chainId: string): string {
  if (networkRegistry[chainId]) return networkRegistry[chainId]
  return chainId === L2_CHAIN ? L2_RPC : L1_RPC
}

// Spec 003 multi-network protocol — recommended integrator dispatch pattern.
// Per-blockchain logic is bundled into a handlers table keyed by CAIP-2 chain id.
// The dispatch decision is `handlers[chainId]` lookup; the chain-id-based
// branching that used to be inline (`if (chainId === L2)`, `if (isL2)`) is
// pushed into per-handler implementations of `executeOps` and `onPermission`.
//
// See specs/003-multi-network-protocol/data-model.md "Integrator Dispatch
// Pattern" for the prescribed shape.

type BlockchainHandlerBundle = {
  rpcUrl: string
  onPermission: (chainId: string, publicKey: string) => Promise<{ publicKey: string }>
  executeOps: (signer: InMemorySigner, operations: any[]) => Promise<string>
}

function normalizeOps(operations: any[]): any[] {
  return operations.map((op: any) => {
    if (op.kind === 'transaction') {
      return { kind: 'transaction' as const, to: op.destination, amount: parseInt(op.amount, 10), mutez: true }
    }
    return op
  })
}

async function executeL1Ops(
  signer: InMemorySigner,
  rpcUrl: string,
  operations: any[],
): Promise<string> {
  const tezos = new TezosToolkit(rpcUrl)
  tezos.setSignerProvider(signer)
  const ops = normalizeOps(operations)
  const result = await tezos.contract.batch(ops).send()
  return result.hash
}

async function executeL2Ops(
  signer: InMemorySigner,
  rpcUrl: string,
  operations: any[],
): Promise<string> {
  // Tezos X L2 (Michelson interface protocol PtTALL…) needs explicit fee
  // estimation with safety margins because Taquito 24.2.0 underestimates,
  // and counter-based inclusion polling because blocks/{id}/operations is
  // not exposed.
  const tezos = new TezosToolkit(rpcUrl)
  tezos.setSignerProvider(signer)
  const ops = normalizeOps(operations)

  const estimates = await tezos.estimate.batch(ops)
  const opsWithFees = ops.map((op: any, i: number) => ({
    ...op,
    fee: Math.ceil((estimates[i]?.suggestedFeeMutez ?? 0) * 2) + 100,
    gasLimit: Math.max(Math.ceil((estimates[i]?.gasLimit ?? 1000) * 3), 5000),
    storageLimit: Math.max(estimates[i]?.storageLimit ?? 257, 300),
  }))
  const addr = await signer.publicKeyHash()
  const counterBefore = await tezos.rpc
    .getContract(addr, { block: 'head' })
    .then((r) => parseInt(String((r as any).counter ?? -1), 10))
    .catch(() => -1)

  const result = await tezos.contract.batch(opsWithFees).send()

  if (counterBefore >= 0) {
    await new Promise<void>((resolve) => {
      const poll = setInterval(async () => {
        const c = await tezos.rpc
          .getContract(addr, { block: 'head' })
          .then((r) => parseInt(String((r as any).counter ?? 0), 10))
          .catch(() => counterBefore)
        if (c > counterBefore) { clearInterval(poll); clearTimeout(deadline); resolve() }
      }, 3_000)
      const deadline = setTimeout(() => { clearInterval(poll); resolve() }, 60_000)
    })
  }
  return result.hash
}

function buildBlockchainHandlers(): Record<string, BlockchainHandlerBundle> {
  return {
    [L1_CHAIN]: {
      rpcUrl: L1_RPC,
      onPermission: async (_chainId, publicKey) => ({ publicKey }),
      executeOps: (signer, ops) => executeL1Ops(signer, networkRegistry[L1_CHAIN] ?? L1_RPC, ops),
    },
    [L2_CHAIN]: {
      rpcUrl: L2_RPC,
      onPermission: async (_chainId, publicKey) => ({ publicKey }),
      executeOps: (signer, ops) => executeL2Ops(signer, networkRegistry[L2_CHAIN] ?? L2_RPC, ops),
    },
  }
}

// Legacy thin shim: WC2 transport path still routes by RPC URL substring.
// Preserved for the existing WC2 e2e flow; the spec 003 dispatch lives below.
async function executeOps(
  signer: InMemorySigner,
  rpcUrl: string,
  operations: any[],
): Promise<string> {
  const isL2 = rpcUrl.includes('txpark') || rpcUrl.includes('tezlink') || rpcUrl.includes('michelson.previewnet.tezosx')
  return isL2 ? executeL2Ops(signer, rpcUrl, operations) : executeL1Ops(signer, rpcUrl, operations)
}

async function initWC2(signer: InMemorySigner): Promise<void> {
  const { SignClient } = await import('@walletconnect/sign-client')
  wc2Client = await SignClient.init({
    projectId: WC2_PROJECT_ID,
    metadata: {
      name: 'Tezos X Wallet POC',
      description: 'Multi-chain wallet POC',
      url: 'https://trilitech.github.io/tezos-x-octez-connect/wallet/',
      icons: [],
    },
  })

  wc2Client.on('session_proposal', async ({ id, params }: any) => {
    try {
      const reqChains  = params.requiredNamespaces?.tezos?.chains ?? []
      const optChains  = params.optionalNamespaces?.tezos?.chains ?? []
      const allChains  = [...new Set([...reqChains, ...optChains])]
      const walletAddr = await signer.publicKeyHash()
      const accounts   = allChains.map((c: string) => `${c}:${walletAddr}`)

      const { acknowledged } = await wc2Client!.approve({
        id,
        namespaces: {
          tezos: {
            chains: allChains,
            methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
            events: [],
            accounts,
          },
        },
      })
      await acknowledged()
      console.log('[wc2] session approved, chains:', allChains)
    } catch (err: any) {
      console.error('[wc2] session_proposal error:', err.message)
    }
  })

  wc2Client.on('session_request', async ({ topic, id, params }: any) => {
    const { chainId, request } = params
    if (request.method !== 'tezos_send') {
      await wc2Client!.respond({
        topic,
        response: { id, jsonrpc: '2.0', error: { code: -32601, message: 'Method not supported' } },
      })
      return
    }
    const rpcUrl = rpcForChain(chainId)
    lastRpcCall = { chainId, rpcUrl }
    console.log(`[wc2] tezos_send on ${chainId} via ${rpcUrl}`)
    try {
      const ops = request.params?.operations ?? []
      const hash = await executeOps(signer, rpcUrl, ops)
      await wc2Client!.respond({
        topic,
        response: { id, jsonrpc: '2.0', result: { transactionHash: hash } },
      })
      console.log(`[wc2] hash: ${hash}`)
    } catch (err: any) {
      console.error('[wc2] tezos_send error:', err.message)
      await wc2Client!.respond({
        topic,
        response: { id, jsonrpc: '2.0', error: { code: -32000, message: err.message } },
      })
    }
  })

  wc2Ready = true
  console.log('[wc2] SignClient ready')
}

async function main(): Promise<void> {
  const signer = await InMemorySigner.fromSecretKey(WALLET_KEY)
  const publicKey = await signer.publicKey()

  // Start WC2 in the background — don't await so the Matrix wallet also starts
  initWC2(signer).catch((err) => console.error('[wc2] init error:', err.message))

  const client = new WalletClient({
    name: 'Tezos X Wallet POC',
    storage: new MemoryStorage(),
  })
  await client.init()

  // Spec 003: per-blockchain dispatch table for permission + operation handlers.
  const handlers = buildBlockchainHandlers()

  await client.connect(async (message) => {
    // Test-only: mutate the incoming version to simulate an unupgraded
    // wallet. The SDK's OutgoingResponseInterceptor mirrors
    // request.version onto the outgoing response, so this propagates
    // automatically. See spec 002-peer-version-handshake T021 cell B.
    if (overrideOutgoingVersion) {
      ;(message as any).version = overrideOutgoingVersion
    }

    if (message.type === BeaconMessageType.PermissionRequest) {
      // Spec 002-peer-version-handshake: single-branch routing on the
      // peer.version that arrived with the message. v2Mode forces legacy
      // behavior for end-to-end backward-compat tests. Otherwise:
      //   peer.version >= '4' → multi-network handler (reads networks[])
      //   peer.version <  '4' → legacy handler (single-network)
      // No `networks ?? []` field-presence detection.
      // Spec 002-peer-version-handshake: route on peer.version sourced
      // from PeerManager (the authoritative store), not from the message
      // envelope. The SDK currently hardcodes `version: '2'` on the
      // inner permission_request envelope (legacy compat stamp), so the
      // envelope version is NOT the routing key. The dApp's pairing
      // payload carries the real peer.version (= BEACON_VERSION at the
      // dApp), which the wallet stored at pairing time.
      const peers = await client.getPeers()
      const senderId = (message as any).senderId
      const matchingPeer = peers.find(
        (p: any) => p.senderId === senderId || p.publicKey === senderId,
      ) as any
      const peerVersionStr =
        matchingPeer?.version ??
        (message as any).peerVersion ??
        (message as any).version ??
        '0'
      const peerVersion = Number(peerVersionStr)
      const isMultiNetwork =
        !v2Mode && Number.isFinite(peerVersion) && peerVersion >= 4

      console.log(`[wallet] permission_request received: peerVersion=${peerVersionStr} (from ${matchingPeer ? 'peerManager' : 'envelope'}), innerVersion=${(message as any).version}, isMultiNetwork=${isMultiNetwork}, networks=${JSON.stringify((message as any).networks)}`)

      if (isMultiNetwork) {
        // Spec 003 multi-network handler — dispatch through the per-blockchain
        // handlers table. Build the rpc registry from `networks[]` first, then
        // invoke each chain's `onPermission` to assemble the response. The
        // default branch (chain id not in `handlers`) emits a wire-level
        // FR-005 rejection naming the unsupported networks — no partial
        // `accounts[]` is constructed.
        const incomingNetworks: any[] = (message as any).networks ?? []
        networkRegistry = {}
        const seenChainIds = new Set<string>()
        for (const net of incomingNetworks) {
          const raw: string = net.chainId ?? ''
          const chainId = raw.startsWith('tezos:') ? raw : `tezos:${raw}`
          seenChainIds.add(chainId)
          if (net.rpcUrl) networkRegistry[chainId] = net.rpcUrl
        }
        const requestedChainIds = [...seenChainIds]
        const unsupportedNetworks = requestedChainIds.filter((c) => !handlers[c])
        if (unsupportedNetworks.length > 0) {
          console.log(`[wallet] rejecting permission_request: unsupported networks ${unsupportedNetworks.join(', ')}`)
          await client.respond({
            type: BeaconMessageType.Error,
            id: message.id,
            errorType: 'NETWORK_NOT_SUPPORTED',
            unsupportedNetworks,
          } as any)
        } else {
          const accounts: Record<string, { publicKey: string }> = {}
          for (const chainId of requestedChainIds) {
            const handler = handlers[chainId]
            accounts[chainId] = await handler.onPermission(chainId, publicKey)
          }
          await client.respond({
            type: BeaconMessageType.PermissionResponse,
            id: message.id,
            publicKey,          // keep for SDK session establishment
            accounts,           // multi-network account map, keyed by CAIP-2 chainId
            network: message.network,
            scopes: message.scopes ?? [PermissionScope.OPERATION_REQUEST],
          } as any)
        }
      } else {
        // Legacy single-network handler. No networks[] inspection.
        await client.respond({
          type: BeaconMessageType.PermissionResponse,
          id: message.id,
          publicKey,
          network: message.network,
          scopes: message.scopes ?? [PermissionScope.OPERATION_REQUEST],
        } as any)
      }
    } else if (message.type === BeaconMessageType.OperationRequest) {
      // Spec 003: dispatch on the CAIP-2 chain id via the handlers table.
      // The wire field can be either a CAIP-2 string (v4 multi-network) or
      // a legacy Network object (v2/v3). Both shapes are normalized to a
      // chain id BEFORE the handler lookup — no per-handler discrimination
      // needed downstream.
      const networkField = (message as any).network
      let chainId: string
      if (typeof networkField === 'string') {
        chainId = networkField.startsWith('tezos:') ? networkField : `tezos:${networkField}`
      } else {
        const raw: string = (networkField as any)?.chainId ?? 'NetXsqzbfFenSTS'
        chainId = raw.startsWith('tezos:') ? raw : `tezos:${raw}`
      }

      const handler = handlers[chainId]
      if (!handler) {
        // FR-005 / spec 003: chain id not in the dispatch table — reject.
        console.log(`[wallet] rejecting operation_request: unsupported network ${chainId}`)
        await client.respond({
          type: BeaconMessageType.Error,
          id: message.id,
          errorType: 'NETWORK_NOT_SUPPORTED',
          unsupportedNetworks: [chainId],
        } as any)
        return
      }
      const rpcUrl = networkRegistry[chainId] ?? handler.rpcUrl
      lastRpcCall = { chainId, rpcUrl }

      try {
        const hash = await handler.executeOps(signer, message.operationDetails as any[])
        await client.respond({
          type: BeaconMessageType.OperationResponse,
          id: message.id,
          transactionHash: hash,
        } as any)
      } catch (err: any) {
        console.error('[wallet] operation error:', err.message)
        console.error('[wallet] operation error full:', JSON.stringify({
          name: err.name,
          message: err.message,
          status: err.status,
          body: err.body?.slice?.(0, 600) ?? err.body,
          errors: err.errors,
        }, null, 2).slice(0, 1500))
        await client.respond({
          type: BeaconMessageType.Error,
          id: message.id,
          errorType: 'UNKNOWN_ERROR',
        } as any)
      }
    }
  })

  const app = express()
  app.use(express.json())
  app.use(express.text({ type: 'text/plain' }))

  // POST /connect — wallet receives pairing URI from test runner
  app.post('/connect', async (req, res) => {
    try {
      const uri = req.body as string
      const peer = await new Serializer().deserialize(uri) as any
      // Spec 002-peer-version-handshake harness: if a beaconVersion
      // override is set, downgrade the incoming peer.version BEFORE
      // addPeer. This makes the wallet's getPeerInfo use the downgraded
      // value for its pairing response, so the dApp's PeerManager
      // stores the downgraded peer.version. That's what makes the
      // dApp-side SDK see the wallet as "unupgraded" (peer.version='3')
      // and raise VersionUnsupportedBeaconError. Test-only.
      console.log(`[wallet] /connect: peer.version=${peer?.version}, override=${overrideOutgoingVersion}`)
      if (overrideOutgoingVersion && peer && typeof peer === 'object') {
        peer.version = overrideOutgoingVersion
        console.log(`[wallet] /connect: after override, peer.version=${peer.version}`)
      }
      await client.addPeer(peer)
      res.sendStatus(200)
    } catch (err: any) {
      console.error('[wallet] addPeer error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /last-rpc-call — last operation_request routing (chainId + rpcUrl)
  app.get('/last-rpc-call', (_req, res) => {
    res.json(lastRpcCall)
  })

  // POST /set-mode — toggle v2/v3 behavior (for backward-compat tests)
  // Body: { mode: "v2" | "v3" }
  app.post('/set-mode', (req, res) => {
    const { mode } = req.body ?? {}
    if (mode === 'v2') { v2Mode = true; res.sendStatus(200) }
    else if (mode === 'v3') { v2Mode = false; res.sendStatus(200) }
    else res.status(400).json({ error: 'mode must be "v2" or "v3"' })
  })

  /**
   * POST /test-config — spec 002-peer-version-handshake harness control.
   *
   * Body shape:
   *   {
   *     beaconVersion?: string  // e.g. '3' simulates an unupgraded wallet
   *     overrideOutgoingVersion?: string  // alias of beaconVersion
   *     transport?: 'matrix' | 'walletconnect' | 'postmessage'  // ignored today;
   *       transport is selected at wallet startup. Accepted in the API
   *       for symmetry with the dApp harness and forward compat.
   *     v2Mode?: boolean  // explicit legacy-mode override (same as POST /set-mode).
   *   }
   *
   * Pass an empty body `{}` to clear all overrides.
   */
  app.post('/test-config', (req, res) => {
    const body = (req.body ?? {}) as any
    // Only update overrideOutgoingVersion when the caller explicitly
    // includes a beaconVersion (or overrideOutgoingVersion) key. Omitting
    // the key MUST preserve the existing override; this lets clients
    // set v2Mode independently without clobbering the version override.
    if ('beaconVersion' in body || 'overrideOutgoingVersion' in body) {
      const targetVersion = body.beaconVersion ?? body.overrideOutgoingVersion ?? null
      if (targetVersion !== null && !/^\d+$/.test(String(targetVersion))) {
        res.status(400).json({
          error: 'beaconVersion must be a decimal-integer string or null',
        })
        return
      }
      overrideOutgoingVersion = targetVersion === null ? null : String(targetVersion)
    }
    if (typeof body.v2Mode === 'boolean') {
      v2Mode = body.v2Mode
    }
    res.json({
      overrideOutgoingVersion,
      v2Mode,
      note: 'transport selection is set at wallet startup; restart with TRANSPORT=... to change it',
    })
  })

  // GET /wc2-ready — 200 once WC2 SignClient is initialized and listening
  app.get('/wc2-ready', (_req, res) => {
    res.sendStatus(wc2Ready ? 200 : 503)
  })

  // POST /wc2-pair — receive WC2 pairing URI from test, pair with dApp SignClient
  app.post('/wc2-pair', async (req, res) => {
    const { uri } = req.body ?? {}
    if (!uri) { res.status(400).json({ error: 'uri required' }); return }
    if (!wc2Client) { res.status(503).json({ error: 'WC2 not ready' }); return }
    try {
      await wc2Client.pair({ uri })
      res.sendStatus(200)
    } catch (err: any) {
      console.error('[wc2] pair error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /account — sender address (derived from WALLET_KEY)
  app.get('/account', async (_req, res) => {
    try {
      const address = await signer.publicKeyHash()
      res.json({ address })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /reset — clear state
  app.post('/reset', async (_req, res) => {
    lastRpcCall = null
    networkRegistry = {}
    try {
      const peers = await client.getPeers()
      for (const peer of peers) {
        await client.removePeer(peer as any)
      }
    } catch (_e) {}
    res.sendStatus(200)
  })

  app.listen(PORT, () => console.log(`[wallet] listening on :${PORT}`))
}

main().catch((err) => {
  console.error('[wallet] fatal:', err)
  process.exit(1)
})
