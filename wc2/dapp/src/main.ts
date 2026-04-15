import {
  DAppClient,
  NetworkType,
  BeaconEvent,
  Regions,
} from '@tezos-x/octez.connect-dapp'

const L1_CHAIN = 'tezos:NetXsqzbfFenSTS'
const L2_CHAIN = 'tezos:NetXH12Aer3be93'
const L1_RPC   = 'https://rpc.shadownet.teztnets.com'
const L2_RPC   = 'https://demo.txpark.nomadic-labs.com/rpc/tezlink'
const DEST     = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const connDot    = document.getElementById('conn-dot')!
const connLabel  = document.getElementById('conn-label')!
const uriSection = document.getElementById('uri-section')!
const uriDisplay = document.getElementById('uri-display')!
const btnConnect = document.getElementById('btn-connect') as HTMLButtonElement
const btnDisconn = document.getElementById('btn-disconnect') as HTMLButtonElement
const sectionOps = document.getElementById('section-ops') as HTMLElement
const btnL1      = document.getElementById('btn-l1') as HTMLButtonElement
const btnL2      = document.getElementById('btn-l2') as HTMLButtonElement
const l1Status   = document.getElementById('l1-status')!
const l2Status   = document.getElementById('l2-status')!
const l1Hash     = document.getElementById('l1-hash')!
const l2Hash     = document.getElementById('l2-hash')!

// ── State ──────────────────────────────────────────────────────────────────────
type ConnState = 'idle' | 'pairing' | 'connected'
let state: ConnState = 'idle'
let client: DAppClient | null = null
let v3Accounts: Record<string, { publicKey: string }> | null = null

// ── UI helpers ──────────────────────────────────────────────────────────────────
function setConnState(s: ConnState, label: string) {
  state = s
  connDot.className = 'dot ' + (s === 'idle' ? 'dot-idle' : s === 'pairing' ? 'dot-waiting' : 'dot-ok')
  connLabel.innerHTML = label
}

function setOpStatus(el: HTMLElement, s: 'pending' | 'done' | 'err', msg: string) {
  el.className = 'op-status ' + s
  el.textContent = msg
}

// ── Client factory ──────────────────────────────────────────────────────────────
function makeClient(): DAppClient {
  const c = new DAppClient({
    name: 'Tezos X dApp POC',
    disableDefaultEvents: true,
    network: { type: NetworkType.CUSTOM, rpcUrl: L1_RPC, name: 'Shadownet L1' },
    matrixNodes: {
      [Regions.EUROPE_WEST]: [
        'beacon-node-1.octez.io',
        'beacon-node-2.octez.io',
        'beacon-node-3.octez.io',
      ],
    },
  })

  c.subscribeToEvent(BeaconEvent.PAIR_INIT, async (data: any) => {
    try {
      const uri: string = await data.p2pPeerInfo
      uriSection.style.display = 'block'
      uriDisplay.textContent = uri
      setConnState('pairing', 'Waiting for wallet to connect…')
    } catch (_) {}
  })

  return c
}

// ── Connect ──────────────────────────────────────────────────────────────────────
btnConnect.addEventListener('click', async () => {
  if (state !== 'idle') return
  btnConnect.disabled = true
  setConnState('pairing', 'Generating pairing URI…')

  client = makeClient()

  try {
    // Monkey-patch makeRequest to inject networks[] into permission_request
    const orig = (client as any).makeRequest.bind(client)
    ;(client as any).makeRequest = function (req: any, ...args: any[]) {
      if (req?.type === 'permission_request') {
        req.networks = [
          { chainId: L1_CHAIN, rpcUrl: L1_RPC, name: 'Shadownet L1' },
          { chainId: L2_CHAIN, rpcUrl: L2_RPC, name: 'Michelson interface' },
        ]
      }
      return orig(req, ...args)
    }

    const perm: any = await client.requestPermissions()
    ;(client as any).makeRequest = orig  // restore

    if (perm?.accounts && typeof perm.accounts === 'object') {
      v3Accounts = perm.accounts
      const chains = Object.keys(v3Accounts!).join(', ')
      setConnState('connected', `<strong>Connected</strong> · v3 · ${chains}`)
    } else {
      v3Accounts = null
      setConnState('connected', `<strong>Connected</strong> · v2 · ${perm?.publicKey?.slice(0, 12)}…`)
    }

    uriSection.style.display = 'none'
    btnConnect.style.display = 'none'
    btnDisconn.style.display = 'inline-flex'
    sectionOps.style.display = 'block'
    btnL1.disabled = false
    btnL2.disabled = false
  } catch (err: any) {
    setConnState('idle', `<span style="color:#ef4444">Error: ${err.message}</span>`)
    btnConnect.disabled = false
  }
})

// ── Disconnect ────────────────────────────────────────────────────────────────────
btnDisconn.addEventListener('click', async () => {
  try { await client?.clearActiveAccount() } catch (_) {}
  client = null
  v3Accounts = null
  setConnState('idle', 'Not connected')
  uriSection.style.display = 'none'
  btnConnect.style.display = 'inline-flex'
  btnConnect.disabled = false
  btnDisconn.style.display = 'none'
  sectionOps.style.display = 'none'
  ;[l1Status, l2Status].forEach(el => { el.textContent = ''; el.className = 'op-status' })
  ;[l1Hash, l2Hash].forEach(el => { el.style.display = 'none'; el.textContent = '' })
  btnL1.disabled = true
  btnL2.disabled = true
})

// ── Send operation helper ───────────────────────────────────────────────────────
async function sendOp(
  chainId: string,
  statusEl: HTMLElement,
  hashEl: HTMLElement,
  btn: HTMLButtonElement,
) {
  btn.disabled = true
  setOpStatus(statusEl, 'pending', 'Waiting for signature…')

  try {
    // Monkey-patch makeRequest to inject network CAIP-2 on operation_request
    const orig = (client as any).makeRequest.bind(client)
    ;(client as any).makeRequest = function (req: any, ...args: any[]) {
      if (req?.type === 'operation_request') req.network = chainId
      return orig(req, ...args)
    }

    let result: any
    try {
      result = await (client as any).requestOperation({
        operationDetails: [{ kind: 'transaction', amount: '1', destination: DEST }],
      })
    } finally {
      ;(client as any).makeRequest = orig
    }

    hashEl.textContent = result.transactionHash
    hashEl.style.display = 'block'
    setOpStatus(statusEl, 'done', '✓ submitted')
  } catch (err: any) {
    setOpStatus(statusEl, 'err', `✗ ${err.message}`)
    btn.disabled = false
  }
}

btnL1.addEventListener('click', () => sendOp(L1_CHAIN, l1Status, l1Hash, btnL1))
btnL2.addEventListener('click', () => sendOp(L2_CHAIN, l2Status, l2Hash, btnL2))
