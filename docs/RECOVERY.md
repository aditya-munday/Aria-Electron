# Recovery, outage, reconciliation, and retry

This document specifies how Aria recovers after a crash and how it behaves when
the Backend is unreachable or an operation's outcome is uncertain. It extends the
stopping design (`STOP-AND-RECOVERY-DESIGN.md`) with the same honesty rule:
nothing is reported as completed, recovered, or stopped unless it was observed to
reach that state.

## Backend outcome classification

`classifyBackendOutcome` maps a failure onto one of three classes, and the class
drives behaviour:

| Class | Kinds | Behaviour |
| --- | --- | --- |
| `definite_rejection` | validation, forbidden, not_found, unprocessable, … | Reported as-is; never retried |
| `unavailable` | unavailable (503) | The Backend is offline; reads are retried with backoff |
| `uncertain` | timeout, transport, conflict | The write may or may not have been applied; reconciled by reading status |

`availabilityFromOutcome` maps the class onto an availability state
(`online`, `offline`, `unauthenticated`, `unknown`). A definite rejection of a
well-formed request proves the Backend answered, so it is `online`; only
`unavailable` is `offline`, and an uncertain outcome is `unknown` — never
treated as a success.

## Failing closed

The supervisor starts with availability `unknown`. While it was last observed
`offline`:

- New tracked work is refused (`submitRequest`/`dispatch` throw), because Aria
  will not start work it cannot supervise.
- No result is fabricated. A failed read leaves the persisted record exactly as
  it was.
- The emergency stop still works, because it is local and never depends on the
  Backend.

When a write is delivered the availability returns to `online`; `recover()`
probes and re-converges, so a recovered connection resumes normal operation.

## Reconciliation, never resubmission

When a mutating operation's outcome is uncertain, Aria reconciles by reading
authoritative status (`reconcileUncertain`, `reconcileExecutions`). It never
resubmits the operation on the assumption it failed, because it may already have
been applied. `reconcileExecutions` asks the Backend to requeue orphaned
executions (for example after a worker crash) and re-reads the tracked tasks.

## Bounded, idempotent retry

`retryIdempotent` retries only `unavailable` and `uncertain` outcomes, at most
`MAX_ATTEMPTS` times, reusing the same idempotency key on every attempt so a
retried write cannot duplicate a side effect. A persistent outage resolves as a
failure, never as a fabricated success.

## Restart recovery

`AriaSupervisor.recover()` reloads durable supervision state from the store and
re-converges every tracked task against the Backend. A restart never loses
ongoing tasks, pending approvals, or pending questions: they are re-read from the
Backend. If the Backend is unreachable at restart the persisted view is left
intact (nothing is cleared, nothing is invented) and availability is `offline`
until it returns.

## Where a capability is unsupported

A capability the platform does not provide is reported as unsupported. It is
never faked and never given a fallback that pretends.
