/**
 * Approval scope and material-change detection.
 *
 * An approval authorizes **one operation on one task under one principal at one
 * plan version, until it expires** — nothing more. This module makes that
 * explicit and detects when a proposed operation has changed enough that the
 * previous approval no longer covers it, so a material change can never ride in
 * on an earlier grant.
 *
 * The backend's approval object is bound to a task; the operation-level scope
 * (capability, parameters, privilege, risk, affected resources, downtime,
 * recovery) is Aria's responsibility to check before it treats an operation as
 * authorized. A genuine grant always comes from the approval workflow — never
 * from text, a transcript, or a model message.
 */

/**
 * The parts of an operation that, if changed, invalidate a prior approval.
 * `parameters` are compared as a whole; the rest are compared by value.
 */
export interface OperationDescriptor {
  readonly capability: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly privilege: 'user' | 'admin' | 'root';
  readonly riskTier: string;
  readonly affectedResources: readonly string[];
  readonly expectedDowntimeSecs?: number;
  readonly recoveryBehavior?: string;
}

/** An approval, scoped to the exact operation it was issued for. */
export interface ApprovalScope {
  readonly approvalId: string;
  readonly taskId: string;
  readonly principal: string;
  readonly operation: OperationDescriptor;
  readonly planVersion: number;
  readonly expiresAt?: string;
  /** Only a granted approval authorizes; a pending or denied one does not. */
  readonly granted: boolean;
}

export interface OperationRequest {
  readonly taskId: string;
  readonly principal: string;
  readonly operation: OperationDescriptor;
  readonly planVersion: number;
}

export type ApprovalScopeReason =
  | 'wrong_task'
  | 'wrong_principal'
  | 'not_granted'
  | 'expired'
  | 'wrong_plan_version'
  | 'wrong_operation'
  | 'material_change';

export type ApprovalScopeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ApprovalScopeReason; readonly detail?: string };

/**
 * A clock the caller supplies from trusted state — its own wall clock, never a
 * timestamp carried inside the approval being judged. If the gate read
 * `expiresAt` against a "now" the input could set, a stale approval could be
 * kept alive indefinitely.
 */
export interface TrustedClock {
  readonly now: string;
}

function isAfter(instant: string, reference: string): boolean {
  const a = Date.parse(instant);
  const b = Date.parse(reference);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a > b;
}

/**
 * Whether two operations differ in a way that must trigger reassessment. The
 * compared fields are exactly the ones that change the blast radius: target,
 * parameters, privilege, risk, affected resources, expected downtime and
 * recovery behavior. A change to any of them means the prior approval does not
 * cover the new operation.
 */
export function materiallyDifferent(
  previous: OperationDescriptor,
  next: OperationDescriptor,
): { changed: true; fields: readonly string[] } | { changed: false } {
  const fields: string[] = [];
  if (previous.capability !== next.capability) fields.push('capability');
  if (previous.privilege !== next.privilege) fields.push('privilege');
  if (previous.riskTier !== next.riskTier) fields.push('riskTier');
  if (previous.expectedDowntimeSecs !== next.expectedDowntimeSecs) {
    fields.push('expectedDowntimeSecs');
  }
  if (previous.recoveryBehavior !== next.recoveryBehavior) {
    fields.push('recoveryBehavior');
  }
  if (!sameStringSet(previous.affectedResources, next.affectedResources)) {
    fields.push('affectedResources');
  }
  if (!sameParameters(previous.parameters, next.parameters)) {
    fields.push('parameters');
  }
  return fields.length > 0 ? { changed: true, fields } : { changed: false };
}

/**
 * Whether an approval authorizes a specific operation request.
 *
 * Order matters: identity → grant → expiry → plan version → operation → material
 * change. A material change is reported separately from a plain mismatch so the
 * caller can explain *why* reassessment is needed.
 */
export function assertApprovalScope(
  approval: ApprovalScope,
  request: OperationRequest,
  clock: TrustedClock,
): ApprovalScopeResult {
  if (approval.taskId !== request.taskId) {
    return { ok: false, reason: 'wrong_task' };
  }
  if (approval.principal !== request.principal) {
    return { ok: false, reason: 'wrong_principal' };
  }
  if (!approval.granted) {
    return { ok: false, reason: 'not_granted' };
  }
  // Expiry outranks the grant: a granted approval past `expiresAt` is spent.
  if (approval.expiresAt !== undefined && isAfter(clock.now, approval.expiresAt)) {
    return { ok: false, reason: 'expired' };
  }
  if (approval.planVersion !== request.planVersion) {
    return { ok: false, reason: 'wrong_plan_version' };
  }
  if (approval.operation.capability !== request.operation.capability) {
    return { ok: false, reason: 'wrong_operation' };
  }
  const diff = materiallyDifferent(approval.operation, request.operation);
  if (diff.changed) {
    return {
      ok: false,
      reason: 'material_change',
      detail: diff.fields.join(', '),
    };
  }
  return { ok: true };
}

/**
 * Text is never authority. This always returns `false` so a call site can be
 * explicit: a transcript, a model message, or a tool result is not an approval,
 * however it is worded.
 */
export function isTextAnApproval(_text: string): false {
  return false;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

function sameParameters(
  a: Readonly<Record<string, string | number | boolean>>,
  b: Readonly<Record<string, string | number | boolean>>,
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    const key = keysA[i] as string;
    if (key !== keysB[i]) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}
