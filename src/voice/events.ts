/**
 * The voice runtime's observable state.
 *
 * These are the events the future Control Center, Orb and chat window consume.
 * They are emitted by the runtime, not by a window: a window closing must not
 * stop the runtime, and the runtime's state must not be derived from an
 * animation. Every event carries the `sessionId` it belongs to, so a consumer
 * can never attribute a stale event to a newer interaction.
 */

import type { RouteHint } from '../contract/aria-contract.js';

export type VoiceActivationSource = 'push_to_talk' | 'wake_word' | 'text';

export type VoiceSessionState =
  | 'idle'
  | 'capturing'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'cancelled'
  | 'failed';

export interface VoiceEventBase {
  readonly sessionId: string;
  readonly at: number;
}

/**
 * Per-turn latency, measured from the end of the user's speech. `firstAudioMs`
 * is the headline number (time to first sound); `firstDeltaMs` is how long the
 * reply took to start streaming, and `streamGapMs` is the largest pause between
 * two audio chunks (a gaplessness proxy).
 */
export interface VoiceTurnMetrics {
  readonly firstDeltaMs?: number;
  readonly firstAudioMs?: number;
  readonly streamGapMs?: number;
}

export type VoiceEvent =
  | (VoiceEventBase & { readonly type: 'session.started'; readonly source: VoiceActivationSource })
  | (VoiceEventBase & { readonly type: 'capture.started'; readonly deviceId?: string })
  | (VoiceEventBase & { readonly type: 'capture.stopped'; readonly reason: string })
  | (VoiceEventBase & {
      readonly type: 'wake.detected';
      readonly phrase: string;
      readonly confidence: number;
      readonly detectorId: string;
    })
  | (VoiceEventBase & { readonly type: 'speech.start' })
  | (VoiceEventBase & { readonly type: 'speech.end'; readonly durationMs: number })
  | (VoiceEventBase & {
      readonly type: 'utterance.rejected';
      readonly reason: 'empty' | 'too_short' | 'too_long' | 'invalid';
    })
  | (VoiceEventBase & { readonly type: 'transcript'; readonly text: string; readonly final: boolean })
  | (VoiceEventBase & {
      readonly type: 'response';
      readonly text: string;
      readonly route?: RouteHint | null;
    })
  | (VoiceEventBase & {
      readonly type: 'response.delta';
      readonly text: string;
      readonly delta: string;
    })
  | (VoiceEventBase & {
      readonly type: 'route.proposed';
      readonly route: RouteHint;
      readonly prompt: string;
    })
  | (VoiceEventBase & { readonly type: 'synthesis.started'; readonly text: string })
  | (VoiceEventBase & { readonly type: 'playback.started' })
  | (VoiceEventBase & { readonly type: 'playback.finished' })
  | (VoiceEventBase & { readonly type: 'turn.metrics'; readonly metrics: VoiceTurnMetrics })
  | (VoiceEventBase & { readonly type: 'playback.interrupted' })
  | (VoiceEventBase & { readonly type: 'session.state'; readonly state: VoiceSessionState })
  | (VoiceEventBase & { readonly type: 'session.failed'; readonly error: string; readonly kind: string })
  | (VoiceEventBase & { readonly type: 'session.cancelled'; readonly reason: string });

export type VoiceEventListener = (event: VoiceEvent) => void;

/** A tiny synchronous emitter; listeners never affect runtime control flow. */
export class VoiceEventBus {
  private readonly listeners = new Set<VoiceEventListener>();

  on(listener: VoiceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: VoiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving consumer must not break the runtime.
      }
    }
  }
}
