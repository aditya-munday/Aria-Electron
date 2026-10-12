import type { OutputControls, Voice } from '../../contract/aria-contract.js';

export interface FixtureCatalog {
  readonly voices: readonly Voice[];
  readonly sttLanguages: readonly string[];
  readonly ttsLanguages: readonly string[];
  readonly streamingStt: boolean;
  readonly streamingTts: boolean;
  readonly streamingChat: boolean;
  /**
   * The synthesis output controls the fixture Backend advertises. Omitted means
   * the served contract offers none, so tests can assert Aria stays silent about
   * a control it cannot send.
   */
  readonly outputControls?: OutputControls;
}

export const FIXTURE_VOICE_CATALOG: FixtureCatalog = {
  voices: [
    { id: 'aria-en-us', name: 'Aria', language: 'en-US', accent: { tag: 'en-us' }, gender: 'female' },
    { id: 'sol-en-gb', name: 'Sol', language: 'en-GB', accent: { tag: 'en-gb' }, gender: 'male' },
    { id: 'kira-de-de', name: 'Kira', language: 'de-DE', accent: { tag: 'de-de' }, gender: 'female' },
  ],
  sttLanguages: ['en-US', 'en-GB', 'de-DE'],
  ttsLanguages: ['en-US', 'en-GB', 'de-DE'],
  streamingStt: true,
  streamingTts: true,
  streamingChat: true,
  outputControls: { pitch: true, volume: true, styles: true },
};

/** Language metadata matching {@link FIXTURE_VOICE_CATALOG}. */
export const FIXTURE_LANGUAGES: readonly { tag: string; name: string; nativeName?: string }[] = [
  { tag: 'en-US', name: 'English (United States)', nativeName: 'English (US)' },
  { tag: 'en-GB', name: 'English (United Kingdom)', nativeName: 'English (UK)' },
  { tag: 'de-DE', name: 'German (Germany)', nativeName: 'Deutsch' },
];

export const FIXTURE_STT_LANGUAGES = FIXTURE_VOICE_CATALOG.sttLanguages;
