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

// --- voice runtime --------------------------------------------------------
export {
  VoiceRuntime,
  type VoiceRuntimeDeps,
  type VoiceRuntimeDiagnostics,
} from './voice/voice-runtime.js';
export { VoiceError, isVoiceError, asVoiceError, recoveryForVoiceError, type VoiceErrorKind, type VoiceErrorRecovery } from './voice/errors.js';
export {
  VoiceEventBus,
  type VoiceEvent,
  type VoiceEventListener,
  type VoiceSessionState,
  type VoiceActivationSource,
} from './voice/events.js';
export {
  loadVoiceConfig,
  validateVoiceConfig,
  DEFAULT_VOICE_CONFIG,
  type VoiceRuntimeConfig,
} from './voice/voice-config.js';
export {
  SPEECH_SAMPLE_RATE,
  MAX_UTTERANCE_MS,
  MAX_PCM_BYTES,
  assertAudioFormat,
  isSupportedAudioFormat,
  frameSamples,
  pcmDurationMs,
  type AudioFormat,
} from './voice/audio-format.js';
export { AudioRingBuffer, type RingBufferStats } from './voice/ring-buffer.js';
export {
  createNoiseReducer,
  NoiseReducer,
  DEFAULT_NOISE_REDUCTION,
  type NoiseReductionConfig,
  type NoiseReductionStats,
} from './voice/noise-reduction.js';
export {
  createVad,
  VoiceActivityDetector,
  DEFAULT_VAD,
  type VadConfig,
  type VadEvent,
  type VadFrame,
  type VadState,
} from './voice/vad.js';
export {
  UtteranceAssembler,
  toInt16,
  bytesToBase64,
  type UtteranceOutcome,
  type UtteranceAssemblerConfig,
} from './voice/segmenter.js';
export {
  createPushToTalk,
  PushToTalkController,
  DEFAULT_PUSH_TO_TALK,
  type PushToTalkConfig,
  type PushToTalkIntent,
  type PushToTalkMode,
} from './voice/push-to-talk.js';
export {
  EngineWakeWordDetector,
  WakeWordController,
  createNativeWakeWordDetector,
  DEFAULT_WAKE_WORD,
  type WakeWordConfig,
  type WakeWordDetector,
  type WakeWordEngine,
  type WakeWordDetection,
  type WakeWordActivation,
  type WakeWordStatus,
} from './voice/wake-word.js';
export {
  WakeWordListener,
  type WakeListenerState,
  type WakeWordListenerDeps,
} from './voice/wake-listener.js';
export { ManualSpeaker, type Speaker } from './voice/playback.js';
export type {
  AudioDevice,
  CaptureHandle,
  DeviceChangeEvent,
  Microphone,
  MicrophonePermission,
} from './voice/device.js';
export {
  BackendSpeechProxy,
  voiceErrorFromBackend,
  voiceErrorFromStream,
  type SpeechProxy,
  type SttResult,
  type TtsOptions,
} from './voice/speech.js';
export { ChatOrchestrator, type ChatOrchestratorOptions } from './voice/orchestrator.js';
export {
  VoiceSession,
  raceWithSignal,
  base64ToPcm,
  type VoiceSessionDeps,
  type Orchestrator,
  type UtteranceBoundary,
} from './voice/session.js';

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
