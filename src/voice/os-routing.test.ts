import { describe, expect, it } from 'vitest';

import {
  confirmationPrompt,
  confirmationReply,
  interpretConfirmation,
  requiresConfirmation,
} from './os-routing.js';

const RESTART = { capability: 'system.restart_service', requires_confirmation: true } as const;
const NO_CONFIRM = { capability: 'desktop.open_app', requires_confirmation: false } as const;

describe('requiresConfirmation', () => {
  it('is true only for a route hint that asks for confirmation', () => {
    expect(requiresConfirmation(RESTART)).toBe(true);
    expect(requiresConfirmation(NO_CONFIRM)).toBe(false);
    expect(requiresConfirmation(null)).toBe(false);
    expect(requiresConfirmation(undefined)).toBe(false);
  });
});

describe('confirmationPrompt', () => {
  it('names the capability from its id, never inventing a title', () => {
    expect(confirmationPrompt({ capability: 'system.restart_service', requires_confirmation: true })).toBe(
      'Confirm restart service? Say yes or no.',
    );
    expect(confirmationPrompt({ capability: 'shutdown', requires_confirmation: true })).toBe(
      'Confirm shutdown? Say yes or no.',
    );
  });
});

describe('confirmationReply', () => {
  it('keeps the backend question verbatim and appends the yes/no cue', () => {
    const reply = confirmationReply('Restart the API service?', RESTART);
    expect(reply.text).toBe('Restart the API service? Say yes or no.');
    expect(reply.spoken).toBe('Say yes or no.');
  });

  it('does not duplicate a cue the backend already sent', () => {
    const reply = confirmationReply('Restart the API service? Yes or no.', RESTART);
    expect(reply.text).toBe('Restart the API service? Yes or no.');
    expect(reply.spoken).toBe('');
  });

  it('falls back to the capability prompt when the backend sent no text', () => {
    const reply = confirmationReply('   ', RESTART);
    expect(reply.text).toBe('Confirm restart service? Say yes or no.');
    expect(reply.spoken).toBe(reply.text);
  });
});

describe('interpretConfirmation', () => {
  it('reads clear affirmations', () => {
    for (const text of ['yes', 'Yes', 'yeah!', 'sure', 'ok', 'do it', 'go ahead']) {
      expect(interpretConfirmation(text)).toBe('affirm');
    }
  });

  it('reads clear denials', () => {
    for (const text of ['no', 'No.', 'nope', 'cancel', 'never mind']) {
      expect(interpretConfirmation(text)).toBe('deny');
    }
  });

  it('treats anything else as unclear, so it never triggers a system action', () => {
    for (const text of ['', '   ', 'maybe', 'what service', 'yes please restart it']) {
      expect(interpretConfirmation(text)).toBe('unclear');
    }
  });
});
