# Quickstart: Verifying the PR #31 Remediation Locally

**Branch**: `004-fix-pr31-ci-and-review` | **Date**: 2026-05-22

This is the runbook a maintainer follows to verify the remediation before pushing to `feat/peer-version-handshake` (which re-triggers the upstream CI). If any step fails, fix and re-run from that step.

## Prerequisites

- Node + npm 11+ available via `./scripts/npm11.sh` in the `octez.connect` repo.
- Local clone of `trilitech/octez.connect` checked out to `feat/peer-version-handshake` with the remediation commits applied (locally at `/home/ubuntu/projects/tezos-x-octez-connect/octez.connect/`).
- Local clone of `trilitech/tezos-x-octez-connect` for the integration-guide update (Complexity Tracking note in `plan.md`). This is the repo you are reading this file from.
- Network: WC2 relay reachability (the e2e `wc-flow.spec.ts` reaches an external relay).
- For step 5 (real-network gate): a wallet secret key in `WALLET_SK` env var corresponding to a ghostnet-funded account, per Constitution Principle III.

## Step 1 — Build clean

```bash
cd /home/ubuntu/projects/tezos-x-octez-connect/octez.connect
./scripts/npm11.sh run build:packages
```

**Expected**: all 12 workspace packages build clean topologically. If TypeScript reports a type error in the typed `PermissionRequest.networks?` field (FR-008), that's the lift surfacing a latent issue at a call site — fix the call site, do not loosen the type.

## Step 2 — `lint:new` gate (the primary blocker)

```bash
PR_BASE_SHA=$(git merge-base HEAD origin/master) \
./scripts/npm11.sh run lint:new
```

**Expected**: `Checking N changed file(s) vs <sha> for new lint findings.` followed by `0 new finding(s)`. Exit code 0.

**If non-zero findings**: each one names a file:line and rule. Fix in-line, do not suppress with `// eslint-disable-` unless accompanied by an inline justification (FR-018). Re-run.

## Step 3 — Unit tests

```bash
./scripts/npm11.sh run test --workspace=@tezos-x/octez.connect-core
./scripts/npm11.sh run test --workspace=@tezos-x/octez.connect-dapp
```

**Expected**:
- `octez.connect-core` suite includes the new `compareBeaconVersion` matrix (17+ cases per `contracts/compare-beacon-version.md` test matrix). All green.
- `octez.connect-dapp` suite includes the new cases from FR-012 + FR-013 (5+ new cases: 3 for `requiredMinimumVersion`, 2 for v4 multi-network fanout + FR-019 defensive gate). All green.

## Step 4 — e2e smoke

```bash
./scripts/npm11.sh run e2e:smoke
```

**Expected**: 25 tests, 25 passing OR 24 passing + 1 quarantined (`wc-flow.spec.ts:17` if the master-side reproduction in research.md R1 confirmed the failure is pre-existing).

**If `wc-flow.spec.ts:17` fails on this branch but the maintainer has NOT yet run the master-side reproduction**: stop. Run `git checkout master && ./scripts/npm11.sh run e2e:smoke -- --grep wc-flow` three times. Decide quarantine-vs-fix per FR-003. Then return to this step.

**If the `afterEach` `TypeError: dappCtx.close is not a function` reappears**: the resilient-afterEach fix (FR-002) regressed or was never applied — fix `e2e/wc-flow.spec.ts` to test `typeof dappCtx?.close === 'function'` before calling, or restructure beforeEach so `pairWithWCWallet` returns even on partial failure.

## Step 5 — Real-network multi-network gate (Constitution Principle III)

This step lives in the companion repo `trilitech/tezos-x-octez-connect`, not in `octez.connect`. It exists because Constitution Principle III requires real ghostnet + Tezos X previewnet validation for any change that touches the dApp-side account-materialisation hot path — which the C10 fix (FR-011) does.

```bash
cd /home/ubuntu/projects/tezos-x-octez-connect
# Bump the SDK pin to the local octez.connect HEAD (or to the pushed PR head once available)
# Then run the multi-network e2e cell:
WALLET_SK=<ghostnet-funded-key> npx tsx test/phase3-multi-network.ts
```

**Expected**: matrix-P2P session pairs against the dApp; two operations on two distinct chain ids (`tezos:NetXxx…` for L1 + `tezos:NetXyz…` for Tezos X previewnet) complete green in one session.

**If a `MissingPermissionError` appears on the second operation**: the C10 `getAccountIdentifier` switch was applied to materialisation but `PermissionValidator` is still computing the new-scheme key from a different input shape than expected. Add a `console.log` of both the persisted `accountIdentifier` and the freshly-computed one — they should match. Fix the mismatch in `blockchain-tezos/src/blockchain.ts`'s call to `getAccountIdentifier(address, network)`.

**If `StalePermissionSchemeError` appears**: that's the FR-011a code path firing — expected on a session paired under the broken scheme. Clear local storage (or call `clearActiveAccount` in the test) and re-pair.

## Step 6 — Verify Copilot threads can resolve

For each of the 11 Copilot inline comments enumerated in the spec (C1..C11), confirm the corresponding code change exists in the diff:

| Comment | File | Verify |
|---|---|---|
| C1, C9 | `IncomingRequestInterceptor.ts` | `await` before each `handleV[234]Message` call; `try { ... } catch { logger.warn(...); }` around the `compareBeaconVersion` call |
| C2, C8 | `message-utils.ts` | Strict integer regex; throws `InvalidBeaconVersionError` |
| C3 | `octez.connect-types/src/index.ts` | `export ... RequestPermissionNetwork` line present |
| C4 | `DAppClient.ts` `requestPermissions` | `request.networks = ...` (no `as any`) |
| C5 | `DAppClientOptions.ts` | JSDoc for `requiredMinimumVersion` mentions `peer.version` (not `walletResponse.version`) |
| C6 | `DAppClient.test.ts` | 3 new cases on `requiredMinimumVersion` |
| C7 | `DAppClient.ts` `requestPermissions` | Only ONE call to `assertWalletVersionMeetsMinimum` (or none, if `getPeer()` is now sufficient) |
| C10 | `blockchain-tezos/src/blockchain.ts` | `accountId` derived via `getAccountIdentifier(address, network)`; `deriveAccountId` helper either removed or relegated to a comment explaining what NOT to do |
| C11 | `DAppClient.test.ts` | 2 new cases on v4 multi-network fanout + FR-019 |

Then, on the PR page, mark each thread Resolved with a brief reply pointing at the remediation commit SHA (FR-017).

## Step 7 — Push and watch CI

```bash
cd /home/ubuntu/projects/tezos-x-octez-connect/octez.connect
git push origin feat/peer-version-handshake
```

Watch the resulting Actions run. **Expected**: both `build-and-unit` and `end-to-end` conclude `SUCCESS`. If a previously-passing `base-flow` or `p2p-flow` cell now fails, the remediation introduced a regression in one of the hot paths it touched — most likely the C10 scheme change colliding with a path that was passing the broken scheme before. Bisect and fix.

## Done condition

- Step 2 reports `0 new finding(s)`.
- Steps 3, 4, 5 all green.
- Step 6 confirms all 11 Copilot fixes present in the diff.
- Step 7 reports CI green; the PR's "Merge" button is enabled.
- All 11 Copilot threads marked Resolved.
