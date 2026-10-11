# Stopping, cancelling, interrupting, and recovering — design

This document specifies how Aria reports stopping and recovering, and why each
operation is kept distinct. The guiding rule is that Aria must never report a
task as stopped, cancelled, completed, or recovered unless it was actually
observed to reach that state.

## The four controls are distinct

| Control | What it does | What it must never imply |
| --- | --- | --- |
| Emergency stop | Halts capture, playback, and scheduling of new work locally, at once | That any running task was stopped |
| Task cancellation | Asks the worker to stop and waits for confirmation | That the stop happened before it is observed |
| Interrupt speech / stop playback | Stops local audio now | That the underlying task was cancelled |
| Microphone mute | Blocks capture, wake-word and push-to-talk input | That a task was cancelled or speech interrupted |

No control is a synonym for another. Emergency stop engages a local halt and
*separately* requests cancellation; whether a task actually stopped is read from
the Backend, never inferred from the fact that the button was pressed.

## Emergency stop

`StopController.engage()` is synchronous and local. It calls a `haltLocal` seam
that stops capture and playback and returns a `LocalHaltReport`. It never awaits
the network, a model, or a healthy Backend, so it works offline. It is
deliberately not a task cancellation: the supervisor's `emergencyStopNow()`
performs the remote, best-effort cancellation and reports only what it observed
(`stopped`, `cancellationUnconfirmed`, `unknown`).

## Task cancellation

`confirmCancellation(taskId, deps, { graceMs })` (and
`AriaSupervisor.cancelAndConfirm`) requests cancellation and then polls the
authoritative execution state:

- `confirmed` — the execution state was observed to reach `cancelled`.
- `not_cancellable` — the task already reached a terminal state that is not
  `cancelled` (it completed, failed, or was cancelled by other means).
- `failed` — the request could not be delivered, or the agent did not stop
  within the grace period. The reason (`backend_unavailable` or `grace_elapsed`)
  is reported; a false `cancelled` is never returned.

The executor already modelled "a cancellation request is not a confirmed stop";
this extends the same rule across the runtime and the UI.

## Microphone mute

`MuteController` refuses every capture activation while muted, before any device
is opened, and remembers the exact prior mode. Unmuting restores that mode
verbatim. The muted flag is a persisted value the controller is constructed
with, so the state survives a window reopen. Muting is never a cancellation and
never an emergency stop.

## Recovery, outage, reconciliation, retry

Specified in the recovery document that ships with the recovery change. In
summary: durable supervision state is reloaded and re-converged from the Backend
after a restart; an unreachable Backend fails closed (offline, no new tracked
work, no fabricated results) and resumes when it returns; an operation sent but
unacknowledged is reconciled by reading status, never by resubmitting; retries
are bounded and idempotent so a retried operation never duplicates a side
effect.

## Where a capability is unsupported

A capability the platform does not provide is reported as unsupported. It is
never faked and never given a fallback that pretends.
