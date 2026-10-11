import type { InteractionRuntime } from '../interaction/interaction-controller.js';
import type { RouteHint } from '../contract/aria-contract.js';
import type { VoiceRuntime } from '../voice/voice-runtime.js';

export interface VoiceRuntimeLike {
  pushToTalkPress(): Promise<void>;
  pushToTalkRelease(): Promise<void>;
  sendText(text: string): Promise<{ readonly text: string; readonly route?: RouteHint | null }>;
  interrupt(): Promise<void>;
}

export class VoiceInteractionRuntime implements InteractionRuntime {
  private readonly voice: VoiceRuntimeLike;
  private starts = 0;

  constructor(voice: VoiceRuntimeLike) {
    this.voice = voice;
  }

  captureStarts(): number {
    return this.starts;
  }

  async pushToTalkPress(): Promise<void> {
    this.starts += 1;
    await this.voice.pushToTalkPress();
  }

  async pushToTalkRelease(): Promise<void> {
    await this.voice.pushToTalkRelease();
  }

  async sendText(text: string): Promise<void> {
    await this.voice.sendText(text);
  }

  async interrupt(): Promise<void> {
    await this.voice.interrupt();
  }
}

export function createVoiceInteractionRuntime(voice: VoiceRuntime): InteractionRuntime {
  return new VoiceInteractionRuntime(voice as unknown as VoiceRuntimeLike);
}
