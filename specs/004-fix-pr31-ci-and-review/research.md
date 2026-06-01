# Phase 0 Research: PR #31 CI Failures & Review Comment Remediation

**Branch**: `004-fix-pr31-ci-and-review` | **Date**: 2026-05-22

## Overview

Technical Context has no `NEEDS CLARIFICATION` markers — the four high-impact decisions from `/speckit-clarify` (compareBeaconVersion throws, dApp-side-only C10 fix, force re-pair on stale `PermissionInfo`, warn-log on malformed peer.version) are already encoded in the spec. The remaining research is operational: confirm assumptions the implementation will rely on, scope the audit work the FRs imply, and pre-decide a few small library choices that would otherwise stall the first tasks.

## R1: Reproducibility of `wc-flow.spec.ts:17` on `master`

**Decision**: Investigate before deciding fix-vs-quarantine. Run the suite against the `master` head locally (or in a one-shot CI dispatch if local WC relay reachability is flaky), with the broken `afterEach` already replaced by a resilient version so the test failure is observable instead of masked.

**Rationale**: FR-003 conditions on this — if pre-existing, quarantine with citation; if branch-specific, fix the v4 routing on the wallet side. The error log shows `30s timeout waiting on #activeAccount`, which is symptomatically identical for "WC relay flake" and "v4 routing regression". We cannot tell without running master.

**Alternatives considered**:
- **Skip + ship with quarantine unconditionally**: rejected — this is the easy out, but if the failure is branch-specific we'd be hiding a real regression in `peer.version` routing under WC2. Constitution Principle II makes WC2 a required transport.
- **Run only this branch and assume flake based on relay symptoms**: rejected — same risk.
- **Re-write the test against a deterministic stub relay**: rejected — explicitly forbidden by Constitution Principle III when the test gates a transport-affecting change; also a much larger PR than the remediation justifies.

**Concrete steps** (encoded into tasks.md by `/speckit-tasks`):
1. Fix `e2e/wc-flow.spec.ts` `afterEach` to be safe when `dappCtx` / `walletCtx` were never assigned (i.e. `pairWithWCWallet` threw in `beforeEach`).
2. Locally check out `master` and run `npm run e2e:smoke -- --grep wc-flow` against the same WC relay 3 times. If ≥ 1 of 3 fail with the same `#activeAccount` 30s timeout, declare pre-existing and quarantine on the branch with a comment citing the master-side run output.
3. If 3/3 pass on master but fail on this branch, declare branch-specific and bisect the wallet-side `peer.version` routing change.

## R2: Audit scope for `compareBeaconVersion()` call sites (FR-006)

**Decision**: Enumerate before editing. The tightened contract (throws `InvalidBeaconVersionError` on malformed input) ripples to every caller. The wallet interceptor's `try/catch` is mandatory (FR-005); other callers need a case-by-case decision (let it propagate vs. handle locally).

**Survey** (run `grep -rn "compareBeaconVersion" octez.connect/packages/`):

Local clone confirms three call sites today:
1. `packages/octez.connect-wallet/src/interceptors/IncomingRequestInterceptor.ts:86` — the wallet routing decision. **MUST wrap in try/catch + warn log** (FR-005).
2. `packages/octez.connect-dapp/src/dapp-client/DAppClient.ts` (in `assertWalletVersionMeetsMinimum` and `resolveRequiredMinimumVersion`) — the dApp version-gating. **Let it propagate**: the input here is sourced from the persisted `PeerManager` record, not from a peer envelope; a malformed value indicates corruption worth surfacing (per the Clarifications session decision).
3. Any test file that asserts comparison behaviour. **Add a unit test** in `octez.connect-core` that covers the malformed-input throw and the happy-path return.

**Rationale**: The dApp call sites consume a value that the SDK itself wrote at pairing time. If that value is malformed at read time, the persisted state is corrupted — surfacing is the right behaviour. The wallet call site consumes an untrusted envelope value where malformed is an expected adversarial case.

**Alternatives considered**:
- **Universal `try/catch` everywhere**: rejected — swallows real corruption at the dApp layer and makes debugging harder.
- **Return sentinel + universal null-check**: rejected — already decided against in Clarifications (Q1).

## R3: `PermissionValidator` integration for `StalePermissionSchemeError` (FR-011a)

**Decision**: Detect the stale-scheme case by `(address, chainId)`. When the new-scheme `accountIdentifier` lookup misses, scan the persisted `PermissionInfo` records for any entry whose `address` and `network.chainId` match the failed lookup's `(address, chainId)` pair — regardless of which scheme produced the stored `accountIdentifier`. On hit, throw `StalePermissionSchemeError(address, chainId)`. On miss, fall through to the existing `MissingPermissionError` path.

**Rationale**: We need to distinguish "user paired under the broken scheme" from "user never paired" so the error message can be actionable. Keying the detection on `(address, chainId)` (the conceptual identity of the account-on-chain) rather than on a re-synthesized old-scheme key is scheme-agnostic — if a future scheme migration is needed, the same detection branch keeps working. It also keeps the implementation simple: a single linear scan of the (always-small) persistence collection on the already-error miss path.

**Alternatives considered**:
- **Always throw `MissingPermissionError`, mention stale scheme in the message**: rejected — the human-facing recovery is different (re-pair vs. pair-first-time), and the SDK already has typed errors for analogous cases (`VersionUnsupportedBeaconError`, `NetworksUnsupportedBeaconError`). Consistent ergonomics.
- **Migrate stale entries on detection**: rejected in Clarifications (Q3). The audience is tiny; forcing re-pair is the smallest reliable fix.
- **Add a one-time storage migration on SDK boot**: rejected — same reasoning as Q3.

**Constraint**: `StalePermissionSchemeError` is NOT registered in `BeaconErrorType` (it's a client-side-only error, like `NetworksUnsupportedBeaconError`). It carries `address: string`, `chainId: string`, and a `nextStep: string` field.

## R4: Lint-suppression survey on touched lines (FR-018)

**Decision**: Audit before editing. Run `git diff master...HEAD --name-only -- 'packages/**/*.ts'` and grep each touched file for existing `// eslint-disable-` comments to ensure the remediation does not silently remove an intentional pre-existing suppression alongside a fix.

**Rationale**: FR-018 forbids new suppressions without justification. The corollary is: pre-existing suppressions on lines this PR did NOT introduce are still legal, but if the remediation reformats a block around a suppression and the suppression becomes ineffective, that's a regression. Catch it in the audit, not in CI.

**Expected outcome**: very few pre-existing suppressions on touched lines (the `lint:new` gate already would have flagged any new ones in this PR's history). The likely hits are in `DAppClient.ts` and `blockchain.ts` where pre-existing legacy code uses `any` — those suppressions, if any, stay; the new code from this PR uses the typed shapes.

## R5: ESLint rule semantics for the in-class refactors

**Decision**: Pre-verify two rule behaviours so the remediation doesn't bounce off CI.

- `prefer-arrow/prefer-arrow-functions`: triggered on `function deriveAccountId(...)` and `function networkFromChainId(...)` in `blockchain-tezos/src/blockchain.ts` (lines 104, 114). The rule allows class members and exported declarations under default config. The fix is to rewrite these as `const deriveAccountId = (...) =>` (file-local arrow consts) — they're already file-private helpers, so this is a 2-line edit per function, no API change.
- `padding-line-between-statements`: triggered on adjacent declarations missing blank lines. Pure formatting — add the blank line.

**Rationale**: knowing these are formatting-only edits removes ambiguity in the task breakdown (no need for a "research arrow vs. function" task).

## R6: New error class wiring (FR-006, FR-011a)

**Decision**: Follow the pattern already established by `VersionUnsupportedBeaconError` and `NetworksUnsupportedBeaconError`:
- Add new file under `packages/octez.connect-core/src/errors/`.
- Extend `BeaconError` base class (client-side only — do NOT register in `BeaconErrorType` enum; these never cross the wire).
- Add a new entry in `error-codes.ts`.
- Re-export from `packages/octez.connect-core/src/index.ts`.

**Two new classes**:
- `InvalidBeaconVersionError(a: string, b: string)` — thrown by `compareBeaconVersion`. Carries the two offending operands. Wallet catches and warn-logs; dApp lets it propagate.
- `StalePermissionSchemeError(address: string, chainId: string, nextStep: string)` — thrown by `PermissionValidator`. Carries enough to render an actionable user message.

**Rationale**: parity with existing error classes makes the diff minimal and the integrator surface predictable. Both errors are dApp-side observability surfaces, not wire fields.

## Open items

None. All decisions above are owned by this remediation; `/speckit-tasks` can convert them directly into ordered tasks. The one externally-blocking item is R1's reproduction on `master`, but that step is encoded as a task and does not require further research now.
