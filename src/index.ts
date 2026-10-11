/**
 * Aria-Electron — public entry point.
 *
 * Aria is the local-first voice assistant desktop application. This module
 * exposes the integration foundation: the product-surface client and the task
 * supervisor that coordinate AI-Engineer work through the Directioner Platform
 * Backend.
 */

export { AriaRuntime, type AriaRuntimeOptions } from './runtime.js';
export { loadConfig, normalizeBaseUrl, type AriaConfig } from './config.js';

export { TaskClient, type TaskClientOptions } from './backend/task-client.js';
export type { TaskApi } from './backend/task-api.js';
export {
  AriaClient,
  AriaStreamError,
  type AriaClientOptions,
  type AriaChatInput,
  type AriaSttInput,
  type AriaTtsInput,
} from './backend/aria-client.js';
export { readNdjson, splitLines } from './backend/ndjson.js';
export {
  FetchTransport,
  InMemoryTransport,
  SharedToken,
  NoToken,
  TransportFailure,
  type Transport,
  type StreamingTransport,
  type TokenSource,
  type HttpRequest,
  type HttpResponse,
  type StreamRequest,
  type StreamResponse,
  type RecordedCall,
  type InMemoryRoute,
  type InMemoryStreamRoute,
} from './backend/transport.js';
export { ok, fail, type Result } from './backend/result.js';
export {
  ariaError,
  kindForStatus,
  recoveryForError,
  recoveryOf,
  isRetryableRead,
  type AriaBackendError,
  type AriaErrorKind,
  type AriaErrorRecovery,
} from './backend/product-errors.js';

export {
  AriaSupervisor,
  SupervisorError,
  describeTaskPhase,
  type SupervisorDeps,
  type SupervisionRecord,
  type TaskPhase,
  type SubmitRequestInput,
  type EmergencyStopReport,
} from './supervisor/supervisor.js';
export {
  classifyEngineerEvent,
  requiresUserAttention,
  answerQuestionEvent,
  planDecisionEvent,
  permissionDecisionEvent,
  type EngineerSignal,
  type ProgressUpdate,
  type QuestionRequest,
  type PlanProposal,
  type PermissionRequest,
} from './supervisor/engineer-events.js';
export {
  assertApprovalScope,
  materiallyDifferent,
  isTextAnApproval,
  type ApprovalScope,
  type OperationDescriptor,
  type OperationRequest,
  type ApprovalScopeResult,
  type ApprovalScopeReason,
  type TrustedClock,
} from './supervisor/approval-scope.js';
export {
  FileTaskStore,
  InMemoryTaskStore,
  type TaskStore,
} from './supervisor/task-store.js';

export * from './contract/product-contract.js';
