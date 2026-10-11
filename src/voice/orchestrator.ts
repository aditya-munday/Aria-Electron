/**
 * The Backend-mediated AI orchestrator.
 *
 * Aria does not orchestrate AI locally: recognized text goes to the Backend's
 * conversational proxy (`/v1/chat`), which mediates the AI-Engineer
 * orchestration. This adapter is the one place the voice session meets that
 * proxy, so the session stays independent of how the response is produced.
 *
 * A route hint that requires confirmation is advisory: it is surfaced, never
 * treated as authorization, and turning a request into tracked engineering work
 * is the supervisor's job on the product surface — not this adapter's.
 */

import type { AriaClient } from '../backend/aria-client.js';
import type { ChatMessage, RouteHint } from '../contract/aria-contract.js';
import { VoiceError } from './errors.js';
import type { Orchestrator } from './session.js';

export interface ChatOrchestratorOptions {
  readonly client: AriaClient;
  /** Optional system prompt prefixing each turn. */
  readonly systemPrompt?: string;
  /** The BCP-47 language hint for the backend. */
  readonly language?: string;
}

export class ChatOrchestrator implements Orchestrator {
  private readonly client: AriaClient;
  private readonly systemPrompt: string | undefined;
  private readonly language: string | undefined;
  private readonly history: ChatMessage[] = [];
  private readonly maxHistory = 20;

  constructor(options: ChatOrchestratorOptions) {
    this.client = options.client;
    this.systemPrompt = options.systemPrompt;
    this.language = options.language;
  }

  async respond(input: {
    readonly text: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly text: string; readonly route?: RouteHint | null }> {
    if (input.signal.aborted) {
      throw new VoiceError('cancelled', 'The voice turn was cancelled.');
    }
    const messages: ChatMessage[] = [
      ...(this.systemPrompt !== undefined
        ? [{ role: 'system', content: this.systemPrompt } as const]
        : []),
      ...this.history,
      { role: 'user', content: input.text },
    ];
    const result = await this.client.chat({
      messages,
      ...(this.language !== undefined ? { language: this.language } : {}),
    });
    if (!result.ok) {
      throw new VoiceError('backend_unavailable', result.error.message, result.error);
    }
    const text = result.value.text;
    this.history.push({ role: 'user', content: input.text });
    this.history.push({ role: 'assistant', content: text });
    while (this.history.length > this.maxHistory) this.history.shift();
    return {
      text,
      ...(result.value.route !== undefined ? { route: result.value.route } : {}),
    };
  }

  /** Forget the conversation history (a new conversation). */
  reset(): void {
    this.history.length = 0;
  }
}
