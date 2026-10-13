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
import { TextSegmenter } from './text-segmenter.js';

export interface ChatOrchestratorOptions {
  readonly client: AriaClient;
  /** Optional system prompt prefixing each turn. */
  readonly systemPrompt?: string;
  /** The BCP-47 language hint for the backend. */
  readonly language?: string;
  /** Minimum length of the first spoken sentence (fast mode shrinks it). */
  readonly firstSentenceChars?: number;
}

export class ChatOrchestrator implements Orchestrator {
  private readonly client: AriaClient;
  private readonly systemPrompt: string | undefined;
  private readonly language: string | undefined;
  private readonly firstSentenceChars: number | undefined;
  private readonly history: ChatMessage[] = [];
  private readonly maxHistory = 20;

  constructor(options: ChatOrchestratorOptions) {
    this.client = options.client;
    this.systemPrompt = options.systemPrompt;
    this.language = options.language;
    this.firstSentenceChars = options.firstSentenceChars;
  }

  async respond(input: {
    readonly text: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly confirm?: boolean;
  }): Promise<{ readonly text: string; readonly route?: RouteHint | null }> {
    if (input.signal.aborted) {
      throw new VoiceError('cancelled', 'The voice turn was cancelled.');
    }
    const messages = this.buildMessages(input.text);
    const result = await this.client.chat({
      messages,
      ...(this.language !== undefined ? { language: this.language } : {}),
      ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
    });
    if (!result.ok) {
      throw new VoiceError('backend_unavailable', result.error.message, result.error);
    }
    const text = result.value.text;
    this.remember(input.text, text);
    return {
      text,
      ...(result.value.route !== undefined ? { route: result.value.route } : {}),
    };
  }

  /**
   * The authoritative text is the returned value, not the accumulated deltas; a
   * route hint is surfaced, never treated as authorization. Sentences are
   * released to `onSentence` as soon as they are complete, so speech can start
   * while later deltas are still arriving. A stream that ends without the final
   * event is a failure: partial text is never returned as a finished reply.
   */
  async respondStream(
    input: {
      readonly text: string;
      readonly sessionId: string;
      readonly signal: AbortSignal;
      readonly confirm?: boolean;
    },
    onDelta: (delta: string) => void,
    onSentence: (sentence: string) => void,
  ): Promise<{ readonly text: string; readonly route?: RouteHint | null }> {
    if (input.signal.aborted) {
      throw new VoiceError('cancelled', 'The voice turn was cancelled.');
    }
    const messages = this.buildMessages(input.text);
    const segmenter = new TextSegmenter(
      this.firstSentenceChars !== undefined ? { minFirstChars: this.firstSentenceChars } : {},
    );
    let text = '';
    let route: RouteHint | null | undefined;
    let sawFinal = false;
    try {
      for await (const event of this.client.chatStream(
        {
          messages,
          ...(this.language !== undefined ? { language: this.language } : {}),
          ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
        },
        { signal: input.signal },
      )) {
        if (event.delta !== '') {
          text += event.delta;
          onDelta(event.delta);
          for (const sentence of segmenter.push(event.delta)) onSentence(sentence);
        }
        if (event.route !== undefined) route = event.route;
        if (event.is_final) {
          sawFinal = true;
          break;
        }
      }
    } catch (error) {
      if (input.signal.aborted) {
        throw new VoiceError('cancelled', 'The voice turn was cancelled.');
      }
      throw new VoiceError(
        'backend_unavailable',
        error instanceof Error ? error.message : 'The chat stream failed.',
        error,
      );
    }
    if (!sawFinal) {
      throw new VoiceError('backend_unavailable', 'The chat stream ended without a final event.');
    }
    for (const sentence of segmenter.flush()) onSentence(sentence);
    this.remember(input.text, text);
    return { text, ...(route !== undefined ? { route } : {}) };
  }

  private buildMessages(text: string): ChatMessage[] {
    return [
      ...(this.systemPrompt !== undefined
        ? [{ role: 'system', content: this.systemPrompt } as const]
        : []),
      ...this.history,
      { role: 'user', content: text },
    ];
  }

  private remember(userText: string, responseText: string): void {
    this.history.push({ role: 'user', content: userText });
    this.history.push({ role: 'assistant', content: responseText });
    while (this.history.length > this.maxHistory) this.history.shift();
  }

  /** Forget the conversation history (a new conversation). */
  reset(): void {
    this.history.length = 0;
  }
}
