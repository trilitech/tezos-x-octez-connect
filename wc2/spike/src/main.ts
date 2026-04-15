import {
  DAppClient,
  NetworkType,
  BeaconEvent,
  Regions,
} from '@tezos-x/octez.connect-dapp'
import {
  WalletClient,
} from '@tezos-x/octez.connect-wallet'

const out = document.getElementById('out')!

function log(msg: string, cls: 'ok' | 'err' | 'dim' | '' = '') {
  const ts = new Date().toISOString().slice(11, 23)
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = `[${ts}] ${msg}`
  out.textContent = ''
  out.appendChild(line)
  out.scrollTop = out.scrollHeight
  console.log(msg)
}

function append(msg: string, cls: 'ok' | 'err' | 'dim' | '' = '') {
  const ts = new Date().toISOString().slice(11, 23)
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = `[${ts}] ${msg}`
  out.appendChild(line)
  out.scrollTop = out.scrollHeight
  console.log(msg)
}

// ── DAppClient spike ──────────────────────────────────────────────────────────

document.getElementById('btn-dapp')!.addEventListener('click', async () => {
  const btn = document.getElementById('btn-dapp') as HTMLButtonElement
  btn.disabled = true
  log('Creating DAppClient…', 'dim')

  try {
    const client = new DAppClient({
      name: 'Spike dApp',
      disableDefaultEvents: true,
      network: {
        type: NetworkType.CUSTOM,
        rpcUrl: 'https://rpc.shadownet.teztnets.com',
        name: 'Shadownet L1',
      },
      matrixNodes: {
        [Regions.EUROPE_WEST]: [
          'beacon-node-1.octez.io',
          'beacon-node-2.octez.io',
          'beacon-node-3.octez.io',
        ],
      },
    })
    append('DAppClient created ✓', 'ok')

    // Capture pairing URI from PAIR_INIT event
    let uriResolve: (uri: string) => void
    const uriPromise = new Promise<string>((res) => { uriResolve = res })

    client.subscribeToEvent(BeaconEvent.PAIR_INIT, async (data: any) => {
      try {
        const uri: string = await data.p2pPeerInfo
        uriResolve(uri)
      } catch (e: any) {
        uriResolve(`ERROR: ${e.message}`)
      }
    })

    append('Calling requestPermissions (pairing URI will appear below)…', 'dim')
    // Don't await — it blocks until wallet responds
    client.requestPermissions().catch(() => {})

    const uri = await Promise.race([
      uriPromise,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15_000)),
    ])

    append(`Pairing URI: ${uri.slice(0, 80)}…`, 'ok')
    append('✅ DAppClient works in browser — PAIR_INIT fired, URI received', 'ok')
  } catch (e: any) {
    append(`❌ ${e.message}`, 'err')
    append(e.stack ?? '', 'err')
  } finally {
    btn.disabled = false
  }
})

// ── WalletClient spike ────────────────────────────────────────────────────────

document.getElementById('btn-wallet')!.addEventListener('click', async () => {
  const btn = document.getElementById('btn-wallet') as HTMLButtonElement
  btn.disabled = true
  log('Creating WalletClient…', 'dim')

  try {
    const client = new WalletClient({ name: 'Spike wallet' })
    append('WalletClient created ✓', 'ok')

    await client.init()
    append('client.init() resolved ✓', 'ok')
    append('✅ WalletClient works in browser', 'ok')
  } catch (e: any) {
    append(`❌ ${e.message}`, 'err')
    append(e.stack ?? '', 'err')
  } finally {
    btn.disabled = false
  }
})
