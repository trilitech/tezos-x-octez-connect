# Phase 1 Data Model: PR #31 Remediation

**Branch**: `004-fix-pr31-ci-and-review` | **Date**: 2026-05-22

This remediation is a code-quality + correctness pass; there are no new persisted entities or database tables. The "data model" here is the **TypeScript public type surface** that changes — new error classes, the typed `networks?` field on `PermissionRequest`, and the persisted `PermissionInfo.accountIdentifier` whose derivation scheme changes (without altering its storage shape).

## Type-surface deltas

### New: `InvalidBeaconVersionError` (`octez.connect-core`)

Thrown by `compareBeaconVersion()` when either operand fails strict decimal-integer validation. Replaces today's generic `new Error(...)` throw.

| Field | Type | Notes |
|---|---|---|
| `name` | `'InvalidBeaconVersionError'` | for `instanceof` and `error.name`-keyed branching |
| `errorCode` | `BeaconErrorCode` enum entry | added to `error-codes.ts`; client-side-only (no `BeaconErrorType` mapping) |
| `a` | `unknown` | the first malformed operand, preserved for logging |
| `b` | `unknown` | the second malformed operand, preserved for logging |
| `message` | `string` | `\`Invalid peer.version comparison: a=${JSON.stringify(a)}, b=${JSON.stringify(b)}\`` (current message preserved) |

**Construction**: `new InvalidBeaconVersionError(a, b)`.

**Catch sites**: `IncomingRequestInterceptor.intercept()` (FR-005). Everywhere else, propagates.

### New: `StalePermissionSchemeError` (`octez.connect-core`)

Thrown by `PermissionValidator` when a v4 Tezos `OperationRequest` cannot resolve against any persisted `PermissionInfo` with the new-scheme `accountIdentifier`, but a stale entry exists at the same `(address, chainId)` derived under the pre-C10 scheme (`${publicKey}-${chainId}`).

| Field | Type | Notes |
|---|---|---|
| `name` | `'StalePermissionSchemeError'` | for `instanceof` and integrator logs |
| `errorCode` | `BeaconErrorCode` enum entry | added to `error-codes.ts`; client-side-only |
| `address` | `string` | `tz1…` of the affected account |
| `chainId` | `string` | CAIP-2 chain id of the affected network |
| `nextStep` | `string` | constant: `'Re-pair this dApp with the wallet to upgrade the persisted permission to the corrected accountIdentifier scheme.'` |
| `message` | `string` | `\`Stale permission scheme for address ${address} on chain ${chainId}. ${nextStep}\`` |

**Construction**: `new StalePermissionSchemeError(address, chainId)` — `nextStep` is filled by the constructor from a module-level constant.

**Throw sites**: `PermissionValidator.validate()` (or whichever method performs the lookup on `OperationRequest`).

**Catch sites**: none in the SDK; the dApp integrator surface is responsible for rendering the error to the user.

### Typed: `PermissionRequest.networks?` and `PermissionRequestInput.networks?` (`octez.connect-types`)

The field already exists at runtime (set via `(request as any).networks = ...` in `DAppClient.requestPermissions`). The remediation lifts it into the type system.

| Field | Type | Notes |
|---|---|---|
| `networks?` | `RequestPermissionNetwork[]` (existing exported interface) | optional; absent → legacy single-network path (BC matrix row 1) |

**On-wire shape unchanged**: this is a purely-additive TypeScript-level surface lift. JSON serialisation produces the same bytes as today.

**Files touched**:
- `packages/octez.connect-types/src/types/beacon/messages/PermissionRequest.ts` — add the field to the interface (and any `…Input` alias).
- `packages/octez.connect-types/src/index.ts` — barrel-export `RequestPermissionNetwork` (was previously only its parent interface).

### Unchanged storage shape: `PermissionInfo.accountIdentifier`

The persisted `PermissionInfo.accountIdentifier` field is a `string` — and remains a `string`. The remediation changes the *derivation function* used to compute that string, not the storage type.

| Field | Today's derivation (broken) | After remediation |
|---|---|---|
| `PermissionInfo.accountIdentifier` (Tezos v4 multi-network) | `deriveAccountId(publicKey, chainId)` → `\`${publicKey}-${chainId}\`` | `getAccountIdentifier(address, network)` (same scheme used by `PermissionValidator`) |

**On-disk migration**: none. Stale entries persisted under the broken scheme are detected at lookup time and surfaced via `StalePermissionSchemeError` (FR-011a). Detection key is `(address, chainId)` — i.e. when the new-scheme `accountIdentifier` lookup misses, `PermissionValidator` scans the persisted `PermissionInfo` collection for any record whose `address` and `network.chainId` match the failed lookup's pair, regardless of which scheme produced the stored `accountIdentifier`. This is scheme-agnostic and survives any future scheme migration. The user re-pairs to upgrade. No background scan, no rewrite.

**BC implication for the broader matrix**: this is a dApp-side internal scheme. The wallet never sees `accountIdentifier`. The wire format is unchanged. No row of the PR-body BC matrix is invalidated by the change.

## Wire shapes — NO CHANGE

For completeness and to make the no-change explicit: the following on-wire types are **not** touched by this remediation:
- `PermissionResponse` (and its `blockchainData.accounts` map for v4)
- `OperationRequest` (and its widened `network: Network | string` field from spec 003)
- The `BeaconErrorType` enum (the two new errors are client-side-only)
- `peer.version` envelope semantics (still the routing key; still sourced from `PeerManager` on the dApp side; still stamped from `BEACON_VERSION` on the wallet side)
- `BEACON_VERSION` constant value (`'4'`)

## State transitions

One transition relevant to this remediation, captured for clarity:

```
[user paired under pre-C10 SDK, on-disk PermissionInfo with broken accountIdentifier]
    │
    │  user installs PR #31 + remediation
    │
    ▼
[user calls requestOperation({ network: tezos:NetXxxx })]
    │
    │  PermissionValidator computes new-scheme accountIdentifier → miss
    │  PermissionValidator computes old-scheme accountIdentifier → hit on stale entry
    │
    ▼
[SDK throws StalePermissionSchemeError(address, chainId)]
    │
    │  dApp UI surfaces error; user clicks "re-pair"
    │
    ▼
[user pairs again under remediated SDK]
    │
    │  PermissionInfo persisted with new-scheme accountIdentifier
    │
    ▼
[requestOperation succeeds; no further StalePermissionSchemeError for this account]
```

## Validation rules

- `compareBeaconVersion(a, b)`: both `a` and `b` MUST match `/^\d+$/` AND be `<= Number.MAX_SAFE_INTEGER` when parsed. Anything else → `InvalidBeaconVersionError`.
- `PermissionRequest.networks?[]`: when present, each element MUST be a `RequestPermissionNetwork` (existing interface, no validation change). `DAppClient.requestPermissions` already dedupes by `chainId` upstream of the wire stamp.
- `StalePermissionSchemeError`: `address` MUST be a non-empty Tezos address string; `chainId` MUST be a non-empty CAIP-2 string. Constructor enforces; throws `Error('invalid args')` if not.
