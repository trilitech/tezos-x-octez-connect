# Contract: `compareBeaconVersion(a, b)` after remediation

**File**: `packages/octez.connect-core/src/utils/message-utils.ts`
**Spec ref**: FR-006, Clarifications Session 2026-05-22 Q1
**Status**: tightened from the existing contract

## Signature

```ts
export const compareBeaconVersion = (a: unknown, b: unknown): number
```

Parameter type widens to `unknown` (was `string`) to express that the function accepts and validates untrusted input, and to force every call site to surface the validation through `try/catch` or via type assertion at the call site rather than silent string coercion.

## Behaviour

**Returns**:
- A number `< 0` if `a < b`
- `0` if `a === b`
- A number `> 0` if `a > b`

Comparison is integer-magnitude (parsed via `BigInt` or `Number()` post-validation; either is acceptable since validation rejects anything outside `0 .. Number.MAX_SAFE_INTEGER`).

**Throws** `InvalidBeaconVersionError(a, b)` when either operand fails any of:

| Validation step | Reject case |
|---|---|
| typeof === 'string' | non-string (number, object, undefined, null) |
| regex match `/^\d+$/` | empty string, leading sign (`"-1"`, `"+4"`), leading zeros (`"04"`), decimal (`"4.1"`), exponent (`"4e0"`), whitespace (`" 4 "`), hex (`"0x4"`), `"NaN"`, `"Infinity"` |
| parsed `<= Number.MAX_SAFE_INTEGER` | overflow above safe-integer bound |

## Error class

```ts
export class InvalidBeaconVersionError extends BeaconError {
  public readonly a: unknown
  public readonly b: unknown

  constructor(a: unknown, b: unknown) {
    super(
      BeaconErrorCode.INVALID_BEACON_VERSION,
      `Invalid peer.version comparison: a=${JSON.stringify(a)}, b=${JSON.stringify(b)}`
    )
    this.name = 'InvalidBeaconVersionError'
    this.a = a
    this.b = b
  }
}
```

**Registered in `BeaconErrorType`?** No. This is a client-side-only error; it never crosses the wire. (Mirrors the existing `NetworksUnsupportedBeaconError` pattern.)

## Call-site obligations

| Call site | Wrap in try/catch? | On catch |
|---|---|---|
| `IncomingRequestInterceptor.intercept()` | **Yes (required)** | Treat as below the v4 threshold; emit `logger.warn(...)` with the offending `peerVersion` + sender peer id; route via legacy branch. Never rethrow. |
| `DAppClient.assertWalletVersionMeetsMinimum()` | No | Let it propagate. Indicates a corrupted persisted peer record. |
| `DAppClient.resolveRequiredMinimumVersion()` | No | Let it propagate. Indicates the dApp passed an invalid `requiredMinimumVersion` to the `DAppClient` constructor — should already have been caught by `InvalidRequiredMinimumVersionError`, but defence in depth. |
| Unit tests in `octez.connect-core` | Yes (via `expect().toThrow(InvalidBeaconVersionError)`) | Asserts the throw + the carried operands. |

## Test matrix

Required Jest cases in `packages/octez.connect-core/__tests__/utils/message-utils.test.ts` (or the existing test file for this util — TBD by `/speckit-tasks`):

| Input `a` | Input `b` | Expected |
|---|---|---|
| `'4'` | `'3'` | returns `> 0` |
| `'3'` | `'4'` | returns `< 0` |
| `'4'` | `'4'` | returns `0` |
| `'10'` | `'2'` | returns `> 0` (NOT lexicographic) |
| `'4.1'` | `'3'` | throws `InvalidBeaconVersionError` |
| `'4e0'` | `'3'` | throws `InvalidBeaconVersionError` |
| `' 4 '` | `'3'` | throws `InvalidBeaconVersionError` |
| `'04'` | `'3'` | throws `InvalidBeaconVersionError` |
| `''` | `'3'` | throws `InvalidBeaconVersionError` |
| `'-1'` | `'3'` | throws `InvalidBeaconVersionError` |
| `'NaN'` | `'3'` | throws `InvalidBeaconVersionError` |
| `'0x4'` | `'3'` | throws `InvalidBeaconVersionError` |
| `undefined` | `'3'` | throws `InvalidBeaconVersionError` |
| `null` | `'3'` | throws `InvalidBeaconVersionError` |
| `4` (number) | `'3'` | throws `InvalidBeaconVersionError` |
| `'4'` | `'4.1'` | throws `InvalidBeaconVersionError` (validation on `b` too) |
| `'9007199254740993'` (above MAX_SAFE_INTEGER) | `'3'` | throws `InvalidBeaconVersionError` |

Plus one integration-style test in `octez.connect-wallet`:

| Setup | Action | Expected |
|---|---|---|
| Build a `message` with `version: 'NaN'` | Pass through `IncomingRequestInterceptor.intercept` | No throw; `logger.warn` was called with `peerVersion: 'NaN'`; routing fell through to the legacy `else if (peerVersion === '2')` branch (which does nothing in this case → `logger.log('intercept', 'Message not handled')`). |

## Backward-compatibility

- Existing callers that pass two valid decimal-integer strings (`'2'`, `'3'`, `'4'`) see no behaviour change — same return value, same sign.
- Existing callers that pass `Number.isFinite`-but-not-strict-integer strings (`'4.1'`, `'4e0'`) USED to silently succeed; they NOW throw. The audit in research.md R2 confirms no production call site passes such values today. If any does, it's a latent bug being surfaced — desired.
- The thrown error class changes from `Error` (generic) to `InvalidBeaconVersionError` (typed). Catch sites that did `catch (e: any)` continue to work; catch sites that did `catch (e: Error)` continue to work (subclass). No catch site exists today that would have to change.
