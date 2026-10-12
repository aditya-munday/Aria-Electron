import { describe, expect, it } from 'vitest';

import { ControlCenterService, type ControlCenterRuntime } from './control-center-service.js';
import type { ShellSettings } from '../shell/settings.js';
import { DEFAULT_SETTINGS, patchSettings } from '../shell/settings.js';
import { fail, ok } from '../backend/result.js';
import { ariaError } from '../backend/product-errors.js';
import type { SupervisionRecord } from '../supervisor/task-store.js';
import type { ActivationInputs } from './state.js';
import type { AriaConfig } from '../config.js';
import {
  FIXTURE_LANGUAGES,
  FIXTURE_STT_LANGUAGES,
  FIXTURE_VOICE_CATALOG,
} from '../voice/testing/fixture-catalog.js';

const CONFIG: AriaConfig = {
  backendBaseUrl: 'https://api.adityamunday.codes',
  requestTimeoutMs: 30_000,
  model: { provider: 'groq', id: 'groq/llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B (Groq)' },
};

const ACTIVATION: ActivationInputs = {
  request: 'Hold ?',
  wakeWordPhrase: 'hey aria',
  chatAccelerator: 'Super+Alt+A',
  pushToTalkAccelerator: 'Super+Alt+Space',
  chatShortcutRegistered: true,
  pushToTalkRegistered: true,
  wakeWordAvailable: true,
};

interface HarnessOptions {
  readonly signedIn?: boolean;
  readonly identityError?: { kind: string; message: string };
  readonly capabilitiesError?: { kind: string; message: string };
  readonly voices?: readonly {
    id: string;
    name: string;
    language: string;
    accent?: string;
    gender?: string;
    styles?: readonly string[];
    description?: string;
  }[];
  readonly languages?: readonly { tag: string; name: string; nativeName?: string }[];
  readonly sttLanguages?: readonly string[];
  readonly outputControls?: { pitch: boolean; volume: boolean; styles: boolean };
  readonly records?: readonly SupervisionRecord[];
  readonly voicePresent?: boolean;
  readonly previewError?: string;
  readonly permission?: 'granted' | 'denied' | 'prompt';
  readonly incidents?: readonly { at: string; source: string; message: string }[];
}

function harness(options: HarnessOptions = {}) {
  let settings: ShellSettings = { ...DEFAULT_SETTINGS };
  const applied: {
    wakeWordEnabled?: boolean;
    pushToTalkMode?: string;
    speakResponses?: boolean;
  }[] = [];
  const speechOutputs: { voice?: string | null; language?: string | null; speed?: number }[] = [];
  const previews: { text: string; voice?: string | null; language?: string | null; speed?: number }[] = [];
  const saved: ShellSettings[] = [];
  const orbVisibility: boolean[] = [];

  const runtime: ControlCenterRuntime = {
    identity: async () =>
      options.identityError !== undefined
        ? fail(ariaError(options.identityError.kind as never, options.identityError.message))
        : ok({
            userId: 'u-42',
            email: 'ada@example.com',
            roles: ['owner'],
            providers: ['password'],
            anonymous: false,
          }),
    capabilities: async () =>
      options.capabilitiesError !== undefined
        ? fail(ariaError(options.capabilitiesError.kind as never, options.capabilitiesError.message))
        : ok({
            voices: options.voices ?? [{ id: 'v1', name: 'Aria', language: 'en-US' }],
            ...(options.languages !== undefined ? { languages: options.languages } : {}),
            ...(options.sttLanguages !== undefined ? { sttLanguages: options.sttLanguages } : {}),
            ...(options.outputControls !== undefined
              ? { outputControls: options.outputControls }
              : {}),
          }),
    records: () => options.records ?? [],
    settings: () => settings,
    saveSettings: (next) => {
      settings = next;
      saved.push(next);
    },
    incidents: () => options.incidents ?? [],
    setOrbVisible: (visible) => {
      orbVisibility.push(visible);
    },
    voiceDiagnostics: () =>
      options.voicePresent === false
        ? undefined
        : {
            wakeWordEnabled: settings.wakeWordEnabled,
            wakeWordStatus: 'ready',
            listening: false,
          },
    voice:
      options.voicePresent === false
        ? undefined
        : {
            setWakeWordEnabled: async (enabled) => {
              applied.push({ wakeWordEnabled: enabled });
            },
            setPushToTalkMode: (mode) => {
              applied.push({ pushToTalkMode: mode });
            },
            setSpeakResponses: (enabled) => {
              applied.push({ speakResponses: enabled });
            },
            setSpeechOutput: (output) => {
              speechOutputs.push(output);
            },
            previewSpeech: async (input) => {
              previews.push(input);
              if (options.previewError !== undefined) throw new Error(options.previewError);
            },
          },
  };

  const service = new ControlCenterService({
    runtime,
    config: CONFIG,
    activation: ACTIVATION,
    microphonePermission: () => options.permission ?? 'granted',
    voiceEngine: () =>
      options.voicePresent === false ? { kind: 'unavailable', reason: 'No engine.' } : { kind: 'native' },
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return {
    service,
    applied,
    speechOutputs,
    previews,
    saved,
    orbVisibility,
    setSettings: (s: ShellSettings) => (settings = s),
  };
}

describe('ControlCenterService.buildState', () => {
  it('reports a signed-in identity from the Backend', async () => {
    const { service } = harness();
    const state = await service.buildState();
    expect(state.account).toMatchObject({
      state: 'signed_in',
      userId: 'u-42',
      email: 'ada@example.com',
      roles: ['owner'],
    });
  });

  it('reports signed out when the Backend returns no token', async () => {
    const { service } = harness({
      identityError: { kind: 'no_token', message: 'Sign in to reach the Directioner backend.' },
    });
    const state = await service.buildState();
    expect(state.account.state).toBe('signed_out');
  });

  it('reports unknown account state when the failure is not authentication', async () => {
    const { service } = harness({
      identityError: { kind: 'server_error', message: 'Backend exploded.' },
    });
    const state = await service.buildState();
    expect(state.account).toMatchObject({ state: 'unknown', reason: 'Something went wrong. Try again.' });
  });

  it('marks the Backend as an outage when capabilities are unreachable', async () => {
    const { service } = harness({
      capabilitiesError: { kind: 'unavailable', message: 'Connection refused.' },
    });
    const state = await service.buildState();
    expect(state.integrations.backend.state).toBe('outage');
  });

  it('treats an identity outage as an outage when capabilities are also unreachable', async () => {
    const { service } = harness({
      identityError: { kind: 'unavailable', message: 'Connection refused.' },
      capabilitiesError: { kind: 'unavailable', message: 'Connection refused.' },
    });
    const state = await service.buildState();
    expect(state.diagnostics.backendState).toBe('outage');
  });

  it('lists the voices the fixture Backend advertises', async () => {
    const { service } = harness({
      voices: FIXTURE_VOICE_CATALOG.voices.map((voice) => ({
        id: voice.id,
        name: voice.name,
        language: voice.language,
        ...(voice.accent !== undefined ? { accent: voice.accent.tag } : {}),
        ...(voice.gender !== undefined ? { gender: voice.gender } : {}),
      })),
      languages: FIXTURE_LANGUAGES,
      sttLanguages: FIXTURE_STT_LANGUAGES,
      outputControls: FIXTURE_VOICE_CATALOG.outputControls,
    });
    const state = await service.buildState();
    expect(state.voice.catalogState).toBe('available');
    expect(state.voice.voices.map((voice) => voice.id)).toEqual([
      'aria-en-us',
      'sol-en-gb',
      'kira-de-de',
    ]);
    expect(state.voice.sttLanguages).toEqual(['en-US', 'en-GB', 'de-DE']);
    expect(state.voice.outputControls).toEqual({ pitch: true, volume: true, styles: true });
  });

  it('preserves the rich voice metadata the Backend advertises', async () => {
    const { service } = harness({
      voices: [
        {
          id: 'v1',
          name: 'Aria',
          language: 'en-US',
          accent: 'en-us',
          gender: 'female',
          styles: ['warm', 'news'],
          description: 'A bright American voice.',
        },
      ],
      languages: [{ tag: 'en-US', name: 'English (United States)', nativeName: 'English (US)' }],
      sttLanguages: ['en-US', 'de-DE'],
    });
    const state = await service.buildState();
    expect(state.voice.voices[0]).toMatchObject({
      id: 'v1',
      accent: 'en-us',
      gender: 'female',
      styles: ['warm', 'news'],
      description: 'A bright American voice.',
    });
    expect(state.voice.languages).toEqual([
      { tag: 'en-US', name: 'English (United States)', nativeName: 'English (US)' },
    ]);
    expect(state.voice.sttLanguages).toEqual(['en-US', 'de-DE']);
  });

  it('carries the configured voice and speech rate into the view', async () => {
    const { service, setSettings } = harness();
    setSettings({ ...DEFAULT_SETTINGS, voice: 'v1', language: 'en-US', speechRate: 1.25 });
    const state = await service.buildState();
    expect(state.voice.configured).toBe('v1');
    expect(state.voice.language).toBe('en-US');
    expect(state.voice.speechRate).toBe(1.25);
  });

  it('surfaces the output controls the Backend advertises', async () => {
    const { service } = harness({ outputControls: { pitch: true, volume: false, styles: true } });
    const state = await service.buildState();
    expect(state.voice.outputControls).toEqual({ pitch: true, volume: false, styles: true });
  });

  it('omits output controls entirely when the Backend does not advertise them', async () => {
    const { service } = harness();
    const state = await service.buildState();
    expect(state.voice.outputControls).toBeUndefined();
  });

  it('disables the voice catalog with a reason when capabilities fail', async () => {
    const { service } = harness({
      capabilitiesError: { kind: 'unavailable', message: 'Connection refused.' },
    });
    const state = await service.buildState();
    expect(state.voice.catalogState).toBe('unknown');
    expect(state.voice.reason).toBe('Aria is temporarily unavailable.');
  });

  it('never surfaces an unrecognized failure kind verbatim', async () => {
    const { service } = harness({
      capabilitiesError: { kind: 'server_error', message: 'Connection refused.' },
    });
    const state = await service.buildState();
    expect(state.voice.reason).toBe('Something went wrong. Try again.');
  });

  it('reports voice input as not ready when the microphone is denied', async () => {
    const { service } = harness({ permission: 'denied' });
    const state = await service.buildState();
    expect(state.diagnostics.voiceReady).toBe(false);
    expect(state.diagnostics.voiceReason).toContain('denied');
  });

  it('surfaces task history ordered by most recently updated', async () => {
    const records = [record('t1', '2026-01-01T00:00:00.000Z'), record('t2', '2026-01-02T00:00:00.000Z')];
    const { service } = harness({ records });
    const state = await service.buildState();
    expect(state.tasks.map((t) => t.taskId)).toEqual(['t2', 't1']);
  });

  it('surfaces reported errors in diagnostics', async () => {
    const { service } = harness({
      incidents: [
        { at: '2026-01-01T00:00:01.000Z', source: 'settings:wakeWord', message: 'engine offline' },
      ],
    });
    const state = await service.buildState();
    expect(state.diagnostics.incidents).toEqual([
      { at: '2026-01-01T00:00:01.000Z', source: 'settings:wakeWord', message: 'engine offline' },
    ]);
  });

  it('reports no incidents when the reporter is empty', async () => {
    const { service } = harness();
    const state = await service.buildState();
    expect(state.diagnostics.incidents).toEqual([]);
  });
});

describe('ControlCenterService.applySettings', () => {
  it('persists an accepted patch and applies it to the runtime', async () => {
    const { service, applied, saved } = harness();
    const result = service.applySettings({ wakeWordEnabled: true, pushToTalkMode: 'toggle' });
    expect(result.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.wakeWordEnabled).toBe(true);
    await Promise.resolve();
    expect(applied).toContainEqual({ wakeWordEnabled: true });
    expect(applied).toContainEqual({ pushToTalkMode: 'toggle' });
  });

  it('rejects an unknown or unsafe settings key without writing', () => {
    const { service, saved } = harness();
    const result = service.applySettings({ token: 'sneaky' });
    expect(result.ok).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('rejects a non-object patch', () => {
    const { service } = harness();
    expect(service.applySettings('nope').ok).toBe(false);
    expect(service.applySettings(null).ok).toBe(false);
    expect(service.applySettings(['wakeWordEnabled']).ok).toBe(false);
  });

  it('does not throw when no voice runtime is present', async () => {
    const { service } = harness({ voicePresent: false });
    const result = service.applySettings({ pushToTalkMode: 'hold' });
    expect(result.ok).toBe(true);
    await Promise.resolve();
  });

  it('pushes a voice/language/rate change to the voice runtime', async () => {
    const { service, speechOutputs } = harness();
    service.applySettings({ voice: 'v2', language: 'en-GB', speechRate: 1.4 });
    await Promise.resolve();
    expect(speechOutputs).toContainEqual({ voice: 'v2', language: 'en-GB', speed: 1.4 });
  });

  it('clears the voice on the runtime when the Backend default is chosen', async () => {
    const { service, speechOutputs } = harness();
    service.applySettings({ voice: null });
    await Promise.resolve();
    expect(speechOutputs).toContainEqual({ voice: null });
  });

  it('pushes a speak-responses change to the voice runtime', async () => {
    const { service, applied } = harness();
    service.applySettings({ speakResponses: false });
    await Promise.resolve();
    expect(applied).toContainEqual({ speakResponses: false });
  });
});

describe('ControlCenterService.previewVoice', () => {
  it('auditions the requested voice through the runtime', async () => {
    const { service, previews } = harness();
    const result = await service.previewVoice({ text: 'hello', voice: 'v1', speed: 1 });
    expect(result.ok).toBe(true);
    expect(previews).toContainEqual({ text: 'hello', voice: 'v1', language: null, speed: 1 });
  });

  it('rejects a malformed preview request without touching the runtime', async () => {
    const { service, previews } = harness();
    expect((await service.previewVoice({ text: '   ' })).ok).toBe(false);
    expect((await service.previewVoice(null)).ok).toBe(false);
    expect(previews).toHaveLength(0);
  });

  it('reports the failure reason when the engine cannot synthesize', async () => {
    const { service } = harness({ previewError: 'No audio output device.' });
    const result = await service.previewVoice({ text: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('No audio output device.');
  });

  it('reports honestly when the build has no bound audio output', async () => {
    const { service } = harness({ voicePresent: false });
    const result = await service.previewVoice({ text: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('audio output');
  });
});

describe('ControlCenterService capability catalog', () => {
  it('exposes the versioned catalog with all capabilities supported on a healthy build', async () => {
    const { service } = harness();
    const state = await service.buildState();
    expect(state.integrations.catalogVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(state.integrations.capabilities.length).toBeGreaterThan(0);
    expect(state.integrations.capabilities.every((c) => c.supported)).toBe(true);
  });

  it('marks voice capabilities unsupported when the build has no voice engine', async () => {
    const { service } = harness({ voicePresent: false });
    const state = await service.buildState();
    const ptt = state.integrations.capabilities.find((c) => c.id === 'voice.push_to_talk');
    expect(ptt?.supported).toBe(false);
    expect(ptt?.reason).toMatch(/microphone/i);
    const stop = state.integrations.capabilities.find((c) => c.id === 'control.emergency_stop');
    expect(stop?.supported).toBe(true);
  });

  it('marks tracked work unsupported while signed out', async () => {
    const { service } = harness({
      identityError: { kind: 'no_token', message: 'Sign in.' },
    });
    const state = await service.buildState();
    const submit = state.integrations.capabilities.find((c) => c.id === 'task.submit');
    expect(submit?.supported).toBe(false);
    expect(submit?.reason).toMatch(/sign in/i);
  });
});

function record(taskId: string, updatedAt: string): SupervisionRecord {
  return {
    taskId,
    title: `Task ${taskId}`,
    status: 'approved',
    version: 1,
    origin: 'user',
    cancellation: 'none',
    verification: 'pending',
    lastSequence: 0,
    pendingQuestions: [],
    pendingPermissions: [],
    pendingPlans: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('patchSettings invariants', () => {
  it('clears an optional value when null is provided', () => {
    const next = patchSettings(
      { ...DEFAULT_SETTINGS, voice: 'v1' },
      { voice: null },
    );
    expect(next.voice).toBeUndefined();
  });
});
