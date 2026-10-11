/**
 * Durable supervision state, owned by the supervisor rather than any window.
 *
 * The Control Center, Orb and chat window may open and close (or crash) freely;
 * task supervision must survive all of it and a full process restart. This store
 * holds, per task, the last authoritative view Aria reconciled from the Backend
 * plus the signals that are waiting on the user.
 *
 * It stores **metadata only** — task identity, status, execution state, and the
 * bounded engineer signals. Conversation text and audio are never persisted here
 * (the backend rejects them from event payloads for the same reason).
 *
 * A JSON file is used deliberately: it is durable across restarts, needs no new
 * service or database, and is trivially inspectable. The backend remains the
 * system of record; this is Aria's local cache for supervision and recovery.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  CancellationState,
  ExecutionOrigin,
  ExecutionState,
  TaskStatus,
  VerificationState,
} from '../contract/product-contract.js';
import type {
  PermissionRequest,
  PlanProposal,
  QuestionRequest,
} from './engineer-events.js';

export interface SupervisionRecord {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly version: number;
  readonly origin: ExecutionOrigin;
  readonly executionId?: string;
  readonly executionState?: ExecutionState;
  readonly attempt?: number;
  readonly cancellation: CancellationState;
  readonly verification: VerificationState;
  readonly leaseOwner?: string;
  /** Highest journal sequence folded into this record. */
  readonly lastSequence: number;
  readonly conversationId?: string;
  readonly sessionId?: string;
  /** Signals awaiting a user response, keyed by their stable id. */
  readonly pendingQuestions: readonly QuestionRequest[];
  readonly pendingPermissions: readonly PermissionRequest[];
  readonly pendingPlans: readonly PlanProposal[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskStore {
  load(): void;
  all(): readonly SupervisionRecord[];
  get(taskId: string): SupervisionRecord | undefined;
  put(record: SupervisionRecord): void;
  remove(taskId: string): void;
}

function clone(record: SupervisionRecord): SupervisionRecord {
  return JSON.parse(JSON.stringify(record)) as SupervisionRecord;
}

/** In-memory store. A real `TaskStore`; used by tests and ephemeral runs. */
export class InMemoryTaskStore implements TaskStore {
  private readonly records = new Map<string, SupervisionRecord>();

  load(): void {
    // Nothing to load; state lives in the map for this process.
  }

  all(): readonly SupervisionRecord[] {
    return [...this.records.values()].map(clone);
  }

  get(taskId: string): SupervisionRecord | undefined {
    const record = this.records.get(taskId);
    return record === undefined ? undefined : clone(record);
  }

  put(record: SupervisionRecord): void {
    this.records.set(record.taskId, clone(record));
  }

  remove(taskId: string): void {
    this.records.delete(taskId);
  }
}

/**
 * A durable JSON-file store. Writes are atomic (write to a temp file, then
 * rename) so a crash mid-write cannot corrupt the file, and a corrupt file is
 * treated as empty rather than crashing the supervisor.
 */
export class FileTaskStore implements TaskStore {
  private readonly path: string;
  private readonly records = new Map<string, SupervisionRecord>();

  constructor(path: string) {
    this.path = path;
  }

  load(): void {
    this.records.clear();
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return; // No file yet: start empty.
    }
    try {
      const parsed = JSON.parse(raw) as { records?: SupervisionRecord[] };
      for (const record of parsed.records ?? []) {
        this.records.set(record.taskId, record);
      }
    } catch {
      // A corrupt file is not a reason to lose the whole app; start empty.
      this.records.clear();
    }
  }

  all(): readonly SupervisionRecord[] {
    return [...this.records.values()].map(clone);
  }

  get(taskId: string): SupervisionRecord | undefined {
    const record = this.records.get(taskId);
    return record === undefined ? undefined : clone(record);
  }

  put(record: SupervisionRecord): void {
    this.records.set(record.taskId, clone(record));
    this.flush();
  }

  remove(taskId: string): void {
    this.records.delete(taskId);
    this.flush();
  }

  private flush(): void {
    const payload = JSON.stringify({ records: [...this.records.values()] }, null, 2);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, this.path);
  }
}
