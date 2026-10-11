/**
 * Interpreting AI-Engineer's structured communication events.
 *
 * AI-Engineer reports progress, asks questions, proposes plan changes and
 * requests permissions as **metadata journal events** on the shared task (the
 * backend's `engineer.*` event types). None of them has lifecycle authority: a
 * question is not an approval, a plan proposal is not authorization, and a
 * permission request is a *request*, not a grant.
 *
 * Event payloads are untrusted input. They are validated and bounded here
 * before Aria acts on them, and the payload may never carry conversation
 * content or credentials (the backend rejects those keys; this is defense in
 * depth for the client).
 */

import { z } from 'zod';

import type { TaskEventDto, TaskEventType } from '../contract/product-contract.js';

// ---------------------------------------------------------------------------
// Bounds — a payload from a peer is untrusted; keep it small and typed.
// ---------------------------------------------------------------------------

const MAX_SUMMARY = 2_000;
const MAX_QUESTION = 2_000;
const MAX_ID = 200;
const MAX_CAPABILITY = 200;
const MAX_SCOPE = 500;
const MAX_OPTIONS = 20;

const summaryField = z.string().min(1).max(MAX_SUMMARY);
const idField = z.string().min(1).max(MAX_ID);

const progressPayload = z.object({
  summary: summaryField,
  percent: z.number().min(0).max(100).optional(),
});

const questionPayload = z.object({
  questionId: idField,
  question: z.string().min(1).max(MAX_QUESTION),
  options: z.array(z.string().max(MAX_QUESTION)).max(MAX_OPTIONS).optional(),
  blocking: z.boolean().optional(),
});

const planPayload = z.object({
  planId: idField,
  planVersion: z.number().int().min(1),
  summary: summaryField,
  operations: z
    .array(
      z.object({
        capability: z.string().min(1).max(MAX_CAPABILITY),
        summary: z.string().max(MAX_SUMMARY).optional(),
      }),
    )
    .max(MAX_OPTIONS)
    .optional(),
});

const permissionPayload = z.object({
  requestId: idField,
  capability: z.string().min(1).max(MAX_CAPABILITY),
  scope: z.string().min(1).max(MAX_SCOPE),
  summary: summaryField.optional(),
  /** Whether the request needs interactive (trusted) authentication. */
  requiresInteractiveAuth: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// The interpretation Aria acts on
// ---------------------------------------------------------------------------

export interface ProgressUpdate {
  readonly kind: 'progress';
  readonly summary: string;
  readonly percent?: number;
}

export interface QuestionRequest {
  readonly kind: 'question';
  readonly questionId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly blocking: boolean;
}

export interface PlanProposal {
  readonly kind: 'plan_proposed';
  readonly planId: string;
  readonly planVersion: number;
  readonly summary: string;
  readonly operations: readonly { capability: string; summary?: string | undefined }[];
}

export interface PermissionRequest {
  readonly kind: 'permission_requested';
  readonly requestId: string;
  readonly capability: string;
  readonly scope: string;
  readonly summary?: string;
  readonly requiresInteractiveAuth: boolean;
}

/** An event Aria understands. `unknown` is a metadata event with no meaning. */
export type EngineerSignal =
  | ProgressUpdate
  | QuestionRequest
  | PlanProposal
  | PermissionRequest
  | { readonly kind: 'unknown'; readonly type: string };

/**
 * Classify a journal event into the signal Aria should act on. A payload that
 * fails validation yields `unknown` — Aria never acts on a malformed event and
 * never surfaces raw peer text as if it were trustworthy.
 */
export function classifyEngineerEvent(event: TaskEventDto): EngineerSignal {
  switch (event.type as TaskEventType | string) {
    case 'engineer.progress': {
      const parsed = progressPayload.safeParse(event.payload ?? {});
      if (!parsed.success) return { kind: 'unknown', type: event.type };
      return {
        kind: 'progress',
        summary: parsed.data.summary,
        ...(parsed.data.percent !== undefined ? { percent: parsed.data.percent } : {}),
      };
    }
    case 'engineer.question': {
      const parsed = questionPayload.safeParse(event.payload ?? {});
      if (!parsed.success) return { kind: 'unknown', type: event.type };
      return {
        kind: 'question',
        questionId: parsed.data.questionId,
        question: parsed.data.question,
        options: parsed.data.options ?? [],
        blocking: parsed.data.blocking ?? true,
      };
    }
    case 'engineer.plan_proposed': {
      const parsed = planPayload.safeParse(event.payload ?? {});
      if (!parsed.success) return { kind: 'unknown', type: event.type };
      return {
        kind: 'plan_proposed',
        planId: parsed.data.planId,
        planVersion: parsed.data.planVersion,
        summary: parsed.data.summary,
        operations: parsed.data.operations ?? [],
      };
    }
    case 'engineer.permission_requested': {
      const parsed = permissionPayload.safeParse(event.payload ?? {});
      if (!parsed.success) return { kind: 'unknown', type: event.type };
      return {
        kind: 'permission_requested',
        requestId: parsed.data.requestId,
        capability: parsed.data.capability,
        scope: parsed.data.scope,
        ...(parsed.data.summary !== undefined ? { summary: parsed.data.summary } : {}),
        requiresInteractiveAuth: parsed.data.requiresInteractiveAuth ?? true,
      };
    }
    default:
      return { kind: 'unknown', type: event.type };
  }
}

/**
 * Whether a signal needs the user's attention before work can proceed. A
 * progress update is informational; a blocking question, a permission request
 * and a plan proposal all pause for the user.
 */
export function requiresUserAttention(signal: EngineerSignal): boolean {
  switch (signal.kind) {
    case 'question':
      return signal.blocking;
    case 'permission_requested':
    case 'plan_proposed':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The user's response, expressed as the events AI-Engineer reads back
// ---------------------------------------------------------------------------

/**
 * Build the metadata events that carry a user's response back to AI-Engineer.
 * These are journal events, not approvals: answering a question or declining a
 * plan proposal never authorizes an operation. A genuine approval must go
 * through the approval workflow (`requestApproval` / `decideApproval`).
 */
export function answerQuestionEvent(
  questionId: string,
  answer: string,
): { type: string; idempotencyKey: string; payload: Record<string, unknown> } {
  return {
    type: 'engineer.answer',
    idempotencyKey: `answer:${questionId}`,
    payload: { questionId, answer: boundText(answer) },
  };
}

export function planDecisionEvent(
  planId: string,
  planVersion: number,
  decision: 'accepted' | 'rejected',
  reason?: string,
): { type: string; idempotencyKey: string; payload: Record<string, unknown> } {
  return {
    type: 'engineer.plan_decision',
    idempotencyKey: `plan:${planId}:v${planVersion}:${decision}`,
    payload: {
      planId,
      planVersion,
      decision,
      ...(reason !== undefined ? { reason: boundText(reason) } : {}),
    },
  };
}

export function permissionDecisionEvent(
  requestId: string,
  decision: 'granted' | 'denied',
  reason?: string,
): { type: string; idempotencyKey: string; payload: Record<string, unknown> } {
  return {
    type: 'engineer.permission_decision',
    idempotencyKey: `permission:${requestId}:${decision}`,
    payload: {
      requestId,
      decision,
      ...(reason !== undefined ? { reason: boundText(reason) } : {}),
    },
  };
}

function boundText(text: string): string {
  return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) : text;
}
