# Tezos X — Octez.connect Multi-chain POC

Proof of concept for extending Octez.connect (TZIP-10) to support single-session multi-chain operations across Tezos L1 and the Michelson interface of Tezos X.

## Status

All six phases of the original POC are validated and done. The protocol-version mechanism was subsequently revised — the multi-chain protocol is now routed by the existing `peer.version` field (bumped from `'3'` to `'4'`) rather than by response-shape detection. See [`specs/002-peer-version-handshake/`](specs/002-peer-version-handshake/) for the spec, plan, and contracts, and the [`feat/peer-version-handshake`](https://github.com/trilitech/octez.connect/tree/feat/peer-version-handshake) branch of `trilitech/octez.connect` (head `ac3194a1`) for the reference SDK implementation.

## Documents

| Document | Description |
|---|---|
| [Proposal](https://trilitech.github.io/tezos-x-octez-connect/) | TZIP-10 extension for multi-chain sessions — problem, proposal, integration, demo |
| [PoC planning and execution](https://trilitech.github.io/tezos-x-octez-connect/poc-plan.html) | Phase-by-phase plan, technical details, and test infrastructure |
| [Wallet integration guide](docs/wallet-multichain-integration.md) | How to extend a Chrome extension or standalone wallet for multi-chain TZIP-10 |
| [Peer-version handshake spec](specs/002-peer-version-handshake/spec.md) | Revised approach: route by `peer.version` (no new field). Supersedes `specs/001-version-negotiation/`. |
| [Multi-network protocol spec](specs/003-multi-network-protocol/spec.md) | dApp-side SDK ergonomics tail: multi-network `getAccounts()`, first-class `requestOperation({ network })`, integrator dispatch pattern. Builds on spec 002. |
| [Demo branch pointer](specs/002-peer-version-handshake/demo-branch.md) | Commit id and reproduction steps for the reference SDK changes on `octez.connect@feat/peer-version-handshake` (now carries both spec 002 and spec 003 commits). |

## Repo structure

```
wc2/
  dapp/         dApp (Vite, port 5173) — multi-chain session demo
  wallet/       Browser wallet (Vite, port 5174) — headless + interactive modes
test/
  phase5.ts     WalletConnect multi-chain session (tsx)
  phase6.ts     Popup transport multi-chain session (Playwright)
docs/
  wallet-multichain-integration.md
specs/
  002-peer-version-handshake/  Active spec: peer.version-based routing
  003-multi-network-protocol/  Active spec: multi-network SDK ergonomics
plan.html       Full development plan (GitHub Pages)
octez.connect/  Local clone of trilitech/octez.connect (gitignored). The
                feat/peer-version-handshake branch in this clone contains
                the reference SDK implementation of specs 002 + 003.
```

## Running the tests

### Phase 5 — WalletConnect

```bash
# Terminal 1
cd wc2/wallet && npx vite --port 5174

# Terminal 2
cd wc2/dapp && npx vite --port 5173

# Terminal 3
npm run test:phase5
```

### Phase 6 — Popup transport (Playwright)

```bash
# Terminal 1
cd wc2/wallet && npx vite --port 5174

# Terminal 2
cd wc2/dapp && npx vite --port 5173

# Terminal 3
npm run test:phase6
```

Both tests require a funded wallet on **both** L1 (ghostnet) and the Michelson interface of Tezos X previewnet. The wallet private key is read from the `WALLET_SK` environment variable (or hardcoded in `wc2/wallet/src/main.ts` for the POC).
