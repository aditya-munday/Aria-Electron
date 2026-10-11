/**
 * The interaction controller: the thin, auditable glue between a routing
 * decision and the code that does the work.
 *
 * The router (`interaction-router.ts`) is pure policy — it decides. This
 * controller executes that decision: it drives the voice runtime for a voice or
 * text interaction, and the local task-control seam for a control activation.
 *
 * The load-bearing property is that a *refused* routing executes nothing. A
 * wake-word activation while detection is disabled, or a push-to-talk press
 * without microphone permission, returns before any `open()` — the microphone
 * is never touched on the strength of "a session was requested". The router's
 * gating is the only gate; the controller adds no second guess.
 */

import {
  isRoutedControl,
  isRoutedSession,
  routeActivation,
  type Activation,
  type InteractionEnvironment,
  type RoutedControl,
  type RoutedResult,
} from './interaction-router.js';

/**
 * The execution seam the controller drives for a voice or text interaction. The
 * production implementation wraps `VoiceRuntime`; a test supplies a recording
 * double, so the controller's decisions are tested without audio hardware.
 */
export interface InteractionRuntime {
  /** Begin push-to-talk capture (the `?` key went down). */
  pushToTalkPress(): void | Promise<void>;
  /** Finalize the held push-to-talk utterance (the `?` key came up). */
  pushToTalkRelease(): void | Promise<void>;
  /** Run a typed turn, bypassing capture and STT. */
  sendText(text: string): void | Promise<void>;
  /** Interrupt speech/playback (barge-in). Never a task cancellation. */
  interrupt(): void | Promise<void>;
}

/**
 * The local-control seam for task state; the supervisor supplies it. As with the
 * router, "request" and "confirmed" are distinct: `requestCancellation` resolves
 * with whether the *request* was accepted, never whether the stop happened.
 */
export interface InteractionControl {
  /**
   * Request cancellation of tracked work. Returns whether the request was
   * accepted. `taskId` is omitted for the emergency stop's "all active" request.
   */
  requestCancellation(taskId?: string): boolean | Promise<boolean>;
  /** Engage the local emergency stop (synchronous, no model, no network). */
  engageEmergencyStop(): void;
}

export interface InteractionControllerDeps {
  /** The live environment, as a value or a getter (permission can change). */
  readonly environment: InteractionEnvironment | (() => InteractionEnvironment);
  readonly runtime: InteractionRuntime;
  /** The task-control seam. Omitted means control activations are inert. */
  readonly control?: InteractionControl;
}

export class InteractionController {
  private readonly deps: InteractionControllerDeps;

  constructor(deps: InteractionControllerDeps) {
    this.deps = deps;
  }

  private environment(): InteractionEnvironment {
    return typeof this.deps.environment === 'function'
      ? this.deps.environment()
      : this.deps.environment;
  }

  /** Route and execute an activation. Returns the routing that was applied. */
  async handle(activation: Activation): Promise<RoutedResult> {
    const result = routeActivation(activation, this.environment());
    if (result.kind === 'refused') return result;
    const routed = result.routed;
    if (isRoutedControl(routed)) {
      await this.applyControl(routed);
      return result;
    }
    if (!isRoutedSession(routed)) return result;
    switch (routed.source) {
      case 'push_to_talk_press':
        await this.deps.runtime.pushToTalkPress();
        break;
      case 'push_to_talk_release':
        await this.deps.runtime.pushToTalkRelease();
        break;
      case 'typed_text':
        await this.deps.runtime.sendText(routed.text ?? '');
        break;
      case 'wake_word':
      case 'app_launch':
      case 'chat_shortcut':
        // Wake-word capture is owned by the runtime's listener, which the
        // controller only starts once; a launch and the chat shortcut start no
        // input here.
        break;
    }
    return result;
  }

  private async applyControl(control: RoutedControl): Promise<void> {
    switch (control.kind) {
      case 'playback_stop':
        await this.deps.runtime.interrupt();
        break;
      case 'task_cancellation_requested':
        await this.deps.control?.requestCancellation(control.taskId);
        break;
      case 'emergency_stop':
        // Local and synchronous first: the stop does not wait on the network,
        // and never on model inference. The cancellation request is best-effort
        // and its confirmation is read later, never assumed here — so a
        // failing orchestration connection must not undo the local engage.
        this.deps.control?.engageEmergencyStop();
        try {
          await this.deps.control?.requestCancellation();
        } catch {
          // The request is best-effort; the local stop is already engaged.
        }
        break;
    }
  }
}
