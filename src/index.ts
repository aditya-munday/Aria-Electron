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

// --- interaction routing --------------------------------------------------
export {
  routeActivation,
  isRoutedSession,
  isRoutedControl,
  DEFAULT_INTERACTION_ENVIRONMENT,
  type Activation,
  type InteractionSurface,
  type InteractionInput,
  type VoiceInputPath,
  type RoutedSession,
  type RoutedControl,
  type Routed,
  type RoutedResult,
  type RouteRefusal,
  type InteractionEnvironment,
} from './interaction/interaction-router.js';
export {
  InteractionController,
  type InteractionControllerDeps,
  type InteractionRuntime,
  type InteractionControl,
} from './interaction/interaction-controller.js';

// --- stop / cancel / interrupt / mute controls ----------------------------
export {
  StopController,
  type StopControllerDeps,
  type EmergencyStopOutcome,
  type LocalHaltReport,
  type SpeechInterruptOutcome,
  type PlaybackStopOutcome,
} from './control/stop-controller.js';
export { MuteController, IDLE_CAPTURE, type CaptureMode, type MuteStateView } from './control/mute.js';
export {
  confirmCancellation,
  describeCancellation,
  DEFAULT_CANCEL_GRACE_MS,
  type CancellationOutcome,
  type CancellationOutcomeKind,
  type CancellationReason,
  type ConfirmCancellationDeps,
  type ConfirmCancellationOptions,
} from './control/cancellation.js';

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
  classifyBackendOutcome,
  availabilityFromOutcome,
  type BackendAvailabilityState,
  type BackendOutcome,
  type BackendOutcomeClass,
} from './backend/backend-outcome.js';
export {
  retryIdempotent,
  MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
  type IdempotentOperation,
  type RetryOptions,
} from './backend/retry.js';
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
  AriaShell,
  type ShellDeps,
  type ShellRuntime,
} from './shell/aria-shell.js';
export {
  InMemorySettingsStore,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type ShellSettings,
  type SettingsStore,
} from './shell/settings.js';
export {
  CHAT_SHORTCUT_ACCELERATOR,
  DEFAULT_KEY_REPERTOIRE,
  type KeyEvent,
  type KeyListener,
  type KeyRepertoire,
  type PhysicalKey,
  type Platform,
  type ShortcutRegistration,
  type WindowFactory,
  type WindowHandle,
  type WindowKind,
  type WindowOptions,
} from './shell/window.js';
export {
  clamp,
  contains,
  type Point,
  type Size,
  type Rect,
} from './shell/geometry.js';
export {
  ORB_RIGHT_MARGIN,
  ORB_VERTICAL_SIXTHS,
  ORB_VERTICAL_DENOMINATOR,
  placeOrb,
  orbCircle,
  type ScreenInfo,
  type ScreenProvider,
} from './shell/placement.js';
export {
  VoiceInteractionRuntime,
  createVoiceInteractionRuntime,
  type VoiceRuntimeLike,
} from './shell/interaction-runtime.js';
export {
  IPC_CHANNELS,
  BRIDGE_API_KEY,
  BRIDGE_METHODS,
  FORBIDDEN_BRIDGE_METHODS,
  createAriaBridge,
  bridgeKeys,
  exposeAriaBridge,
  type AriaBridge,
  type ContextBridge,
  type IpcHandler,
  type IpcInvoker,
  type IpcRegistrar,
  type ShellStatus,
} from './shell/ipc.js';
export { registerIpcHandlers, type IpcHost } from './shell/ipc-handlers.js';
export {
  RENDERER_WEB_PREFERENCES,
  blockExternalNavigation,
  type RendererWindowSecurity,
  type ExternalNavigationGuard,
} from './shell/security.js';
export { createFileSettingsStore } from './shell/settings-file.js';

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

export {
  OrbService,
  type OrbDeps,
  type OrbRuntime,
} from './orb/orb-service.js';
export { resolvePresence } from './orb/assemble.js';
export {
  ORB_DIAMETER,
  ORB_WINDOW_PADDING,
  ORB_WINDOW_SIZE,
  ORB_WINDOW_OPTIONS,
} from './orb/window-options.js';
export { orbHitTest } from './orb/hit-test.js';
export { planOrbBackdrop, type OrbBackdropPlan, type OrbBackdropMaterial } from './orb/backdrop.js';
export {
  ORB_CUE,
  ORB_LABEL,
  isOrbPresence,
  type OrbPresence,
  type OrbCue,
  type OrbPresenceView,
  type OrbState,
  type OrbSources,
  type OrbVoiceDiagnostics,
  type OrbEnvironment,
} from './orb/state.js';

export {
  ChatService,
  type ChatDeps,
  type ChatRuntime,
  type ChatVoiceControl,
  type ChatTaskControl,
  type ApprovalRequestedInput,
} from './chat/chat-service.js';
export { assembleChatState, emergencyStopView } from './chat/assemble.js';
export { createChatRuntime } from './chat/chat-runtime.js';
export type {
  ChatRole,
  ChatTurnState,
  ChatTurn,
  ApprovalDecision,
  ApprovalScopeView,
  ApprovalView,
  QuestionView,
  PlanView,
  PermissionView,
  TaskResultView,
  ChatTaskView,
  EmergencyStopView,
  ChatState,
  ChatSources,
  ChatRecordView,
  ApprovalDecisionOutcome,
  ChatActionResult,
} from './chat/state.js';

export * from './contract/product-contract.js';
