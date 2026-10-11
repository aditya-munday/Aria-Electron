/**
 * Interaction routing.
 *
 * This is the decision layer that sits above the voice runtime: it turns a raw
 * activation — an app launch, a held key, a spoken wake phrase, a window
 * shortcut, a typed message, an emergency stop — into a routed interaction
 * session that names *which surface* takes it and *which input path* it uses.
 *
 * It is deliberately free of any UI, window or `electron` dependency. Callers
 * (the Control Center, the Orb, the chat window, the OS intent broker) ask the
 * router what to do and then do it; the router owns the policy, not the chrome.
 *
 * The distinctions it enforces exist because getting them wrong means lying to
 * the user or starting capture the user did not ask for:
 *   - A normal launch opens the Control Center with *no input path at all*: no
 *     microphone, no STT, no orchestration, no TTS.
 *   - Push-to-talk (hold the `?` key) starts capture immediately and *never*
 *     consults wake-word detection; it must not depend on that model existing.
 *   - The wake word captures audio only *after* activation, and only while
 *     detection is enabled and the microphone is permitted; it must not capture
 *     while disabled.
 *   - `Win + Alt + A` opens the chat window and must not start capture.
 *   - Typed text goes straight to Backend orchestration, bypassing STT.
 *   - Stopping playback is not cancelling a task, and requesting a cancellation
 *     is not a confirmed stop; the router keeps all three as distinct outputs.
 *   - Emergency stop is an independent, local, synchronous control path: it
 *     depends on no model inference and no orchestration connection.
 *
 * A routed session carries its `source` and `input` explicitly. Downstream code
 * must never infer them from a generic "a session exists" flag — that ambiguity
 * is exactly what lets a voice, a text and a task-monitoring session merge.
 */

/**
 * The raw events the router consumes. Windows, the OS intent broker and the
 * voice runtime translate their own inputs into these; the router does not
 * depend on any of them.
 */
export type Activation =
  /** A normal application launch; not a voice or chat activation. */
  | { readonly kind: 'app_launch' }
  /** Push-to-talk: the `?` key went down. Capture runs while held. */
  | { readonly kind: 'push_to_talk_press' }
  /** Push-to-talk: the `?` key came up. The utterance finalizes. */
  | { readonly kind: 'push_to_talk_release' }
  /** The local wake-word detector fired. */
  | { readonly kind: 'wake_word' }
  /** The `Win + Alt + A` shortcut opened the chat window. */
  | { readonly kind: 'chat_shortcut' }
  /** The user submitted typed text from the chat window. */
  | { readonly kind: 'typed_text'; readonly text: string }
  /** A request to interrupt the current speech/playback (barge-in). */
  | { readonly kind: 'stop_playback' }
  /** A request to cancel tracked engineering work (never a confirmed stop). */
  | { readonly kind: 'cancel_task'; readonly taskId: string }
  /** The independent local emergency stop. */
  | { readonly kind: 'emergency_stop' };

/**
 * The surfaces an interaction can target. `control_center` is the shell's home
 * surface; `orb` is the voice surface; `chat` is the typed-conversation window.
 */
export type InteractionSurface = 'control_center' | 'orb' | 'chat';

/**
 * The input path an interaction uses. `none` is a first-class value, not a
 * stand-in for "unknown": a launch and the chat window genuinely take no audio
 * input, and downstream code must not treat that as "capture when ready".
 */
export type InteractionInput = 'none' | 'voice' | 'text';

/**
 * The voice sub-path, matching the runtime's activation vocabulary exactly. It
 * is only set when `input` is `voice`; a control-center or text interaction
 * carries `inputPath: undefined`.
 */
export type VoiceInputPath = 'push_to_talk' | 'wake_word';

export interface RoutedSession {
  /** Always `'launch'` or `'interaction'`; never inferred from a flag. */
  readonly kind: 'launch' | 'interaction';
  readonly surface: InteractionSurface;
  /** The exact activation that produced this routing. */
  readonly source: Activation['kind'];
  readonly input: InteractionInput;
  /** The capture sub-path, present only for voice interactions. */
  readonly inputPath: VoiceInputPath | undefined;
  /** Whether this routing opens the microphone. */
  readonly capture: boolean;
  /** Whether this routing calls STT. False for typed text. */
  readonly transcribe: boolean;
  /** Whether this routing may call Backend orchestration. */
  readonly orchestrates: boolean;
  /** The typed text, present only for a typed interaction. */
  readonly text: string | undefined;
  /** The task id, present only for a task-cancellation request. */
  readonly taskId: string | undefined;
}

/**
 * The three control outputs, deliberately distinct types so no caller can
 * confuse them. They are *not* `RoutedSession`s: none of them opens a session,
 * captures audio, transcribes, orchestrates or speaks.
 */
export type RoutedControl =
  | {
      /** Stop local speech/playback now (barge-in). Not a task cancellation. */
      readonly kind: 'playback_stop';
      readonly source: 'stop_playback';
    }
  | {
      /** Request cancellation of a task. NOT a confirmed stop. */
      readonly kind: 'task_cancellation_requested';
      readonly source: 'cancel_task';
      readonly taskId: string;
    }
  | {
      /**
       * Emergency stop: engage the local stop synchronously, then request
       * cancellation of running work. The engage is local and immediate; the
       * stop is only confirmed later by the Backend, never assumed here.
       */
      readonly kind: 'emergency_stop';
      readonly source: 'emergency_stop';
      readonly engage: { readonly engaged: true };
      readonly requestCancellation: { readonly request: 'all_active' };
    };

export type Routed = RoutedSession | RoutedControl;

export function isRoutedSession(routed: Routed): routed is RoutedSession {
  return routed.kind === 'launch' || routed.kind === 'interaction';
}

export function isRoutedControl(routed: Routed): routed is RoutedControl {
  return !isRoutedSession(routed);
}

/** The local conditions that gate activation, supplied by the environment. */
export interface InteractionEnvironment {
  /**
   * Whether wake-word detection is currently enabled. The *route* must never
   * start a capture for a disabled detector, so this is checked at routing time
   * even though the runtime also refuses.
   */
  readonly wakeWordEnabled: boolean;
  /**
   * The current microphone permission. Push-to-talk and wake-word capture are
   * refused when it is not `granted`.
   */
  readonly microphonePermission: 'granted' | 'denied' | 'prompt';
  /**
   * Whether the user has muted capture. A muted control refuses every voice
   * activation locally, before any device is opened, and is distinct from a
   * denied permission (the user can unmute; only the OS can re-grant).
   */
  readonly captureMuted: boolean;
  /**
   * Whether a voice interaction is already active. The router refuses to merge
   * two voice interactions; a new one is rejected rather than layered.
   */
  readonly voiceSessionActive: boolean;
}

/**
 * A visible, typed reason a routing was refused. It is a value, not a thrown
 * error, so a caller can render it and a test can assert on the exact kind.
 */
export type RouteRefusal =
  | 'wake_word_disabled'
  | 'microphone_not_permitted'
  | 'capture_muted'
  | 'voice_session_active';

export type RoutedResult =
  | { readonly kind: 'routed'; readonly routed: Routed }
  | { readonly kind: 'refused'; readonly source: Activation['kind']; readonly reason: RouteRefusal };

export const DEFAULT_INTERACTION_ENVIRONMENT: InteractionEnvironment = {
  wakeWordEnabled: false,
  microphonePermission: 'prompt',
  captureMuted: false,
  voiceSessionActive: false,
};

/**
 * Route a raw activation into a routed session or control, or refuse it.
 *
 * This is pure: it opens no device and starts no work. It decides, and the
 * caller (or `InteractionController`) executes the decision against the
 * `VoiceRuntime`.
 */
export function routeActivation(
  activation: Activation,
  environment: InteractionEnvironment = DEFAULT_INTERACTION_ENVIRONMENT,
): RoutedResult {
  switch (activation.kind) {
    case 'app_launch':
      // A launch opens the shell home with no input path whatsoever.
      return routed({
        kind: 'launch',
        surface: 'control_center',
        source: activation.kind,
        input: 'none',
        inputPath: undefined,
        capture: false,
        transcribe: false,
        orchestrates: false,
        text: undefined,
        taskId: undefined,
      });

    case 'chat_shortcut':
      // The chat window is text-only: it must never open the microphone.
      return routed({
        kind: 'interaction',
        surface: 'chat',
        source: activation.kind,
        input: 'none',
        inputPath: undefined,
        capture: false,
        transcribe: false,
        orchestrates: false,
        text: undefined,
        taskId: undefined,
      });

    case 'typed_text': {
      const text = activation.text.trim();
      // Typed input goes straight to orchestration; STT is bypassed entirely.
      return routed({
        kind: 'interaction',
        surface: 'chat',
        source: activation.kind,
        input: 'text',
        inputPath: undefined,
        capture: false,
        transcribe: false,
        orchestrates: text !== '',
        text,
        taskId: undefined,
      });
    }

    case 'push_to_talk_press': {
      // Push-to-talk does not depend on wake-word detection or its model; it
      // only requires microphone permission and an unmuted capture control.
      if (environment.captureMuted) {
        return refused(activation.kind, 'capture_muted');
      }
      if (environment.microphonePermission !== 'granted') {
        return refused(activation.kind, 'microphone_not_permitted');
      }
      if (environment.voiceSessionActive) {
        return refused(activation.kind, 'voice_session_active');
      }
      return routed(voiceSession(activation.kind, 'push_to_talk'));
    }

    case 'push_to_talk_release':
      // The release finalizes the held utterance; it starts nothing and does
      // not itself open a session.
      return routed({
        kind: 'interaction',
        surface: 'orb',
        source: activation.kind,
        input: 'voice',
        inputPath: 'push_to_talk',
        capture: false,
        transcribe: false,
        orchestrates: false,
        text: undefined,
        taskId: undefined,
      });

    case 'wake_word': {
      // Capture happens only after activation, and only while detection is
      // enabled, the microphone is permitted, and capture is not muted. A
      // disabled detector never captures.
      if (!environment.wakeWordEnabled) {
        return refused(activation.kind, 'wake_word_disabled');
      }
      if (environment.captureMuted) {
        return refused(activation.kind, 'capture_muted');
      }
      if (environment.microphonePermission !== 'granted') {
        return refused(activation.kind, 'microphone_not_permitted');
      }
      if (environment.voiceSessionActive) {
        return refused(activation.kind, 'voice_session_active');
      }
      return routed(voiceSession(activation.kind, 'wake_word'));
    }

    case 'stop_playback':
      return routed({ kind: 'playback_stop', source: activation.kind });

    case 'cancel_task':
      return routed({
        kind: 'task_cancellation_requested',
        source: activation.kind,
        taskId: activation.taskId,
      });

    case 'emergency_stop':
      // No model inference, no orchestration connection, no async prerequisite:
      // the engage is decided here and the local stop happens synchronously.
      return routed({
        kind: 'emergency_stop',
        source: activation.kind,
        engage: { engaged: true },
        requestCancellation: { request: 'all_active' },
      });
  }
}

function voiceSession(source: 'push_to_talk_press' | 'wake_word', inputPath: VoiceInputPath): RoutedSession {
  // A voice interaction always targets the Orb and always transcribes. It never
  // carries text, so it cannot be mistaken for a typed turn.
  return {
    kind: 'interaction',
    surface: 'orb',
    source,
    input: 'voice',
    inputPath,
    capture: true,
    transcribe: true,
    orchestrates: true,
    text: undefined,
    taskId: undefined,
  };
}

function routed(routedValue: Routed): RoutedResult {
  return { kind: 'routed', routed: routedValue };
}

function refused(source: Activation['kind'], reason: RouteRefusal): RoutedResult {
  return { kind: 'refused', source, reason };
}

