import { describe, expect, it } from 'vitest';

import { ControlCenterService, type ControlCenterRuntime } from './control-center-service.js';
import type { ShellSettings } from '../shell/settings.js';
import { DEFAULT_SETTINGS, patchSettings } from '../shell/settings.js';
import { fail, ok } from '../backend/result.js';
import { ariaError } from '../backend/product-errors.js';
import type { SupervisionRecord } from '../supervisor/task-store.js';
import type { ActivationInputs } from './state.js';
import type { AriaConfig } from '../config.js';

const CONFIG: AriaConfig = {
  backendBaseUrl: 'https://api.beyonders.dev',
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
  readonly voices?: readonly { id: string; name: string; language: string }[];
  readonly records?: readonly SupervisionRecord[];
  readonly voicePresent?: boolean;
  readonly permission?: 'granted' | 'denied' | 'prompt';
  readonly incidents?: readonly { at: string; source: string; message: string }[];
}

function harness(options: HarnessOptions = {}) {
  let settings: ShellSettings = { ...DEFAULT_SETTINGS };
  const applied: { wakeWordEnabled?: boolean; pushToTalkMode?: string }[] = [];
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
        : ok({ voices: options.voices ?? [{ id: 'v1', name: 'Aria', language: 'en-US' }] }),
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
            wakeWordStatus: 'idle',
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
    expect(state.account).toMatchObject({ state: 'unknown', reason: 'Backend exploded.' });
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

  it('lists voices the Backend advertises', async () => {
    const { service } = harness({
      voices: [
        { id: 'v1', name: 'Aria', language: 'en-US' },
        { id: 'v2', name: 'Sol', language: 'en-GB' },
      ],
    });
    const state = await service.buildState();
    expect(state.voice.catalogState).toBe('available');
    expect(state.voice.voices).toHaveLength(2);
  });

  it('disables the voice catalog with a reason when capabilities fail', async () => {
    const { service } = harness({
      capabilitiesError: { kind: 'unavailable', message: 'Connection refused.' },
    });
    const state = await service.buildState();
    expect(state.voice.catalogState).toBe('unknown');
    expect(state.voice.reason).toBe('Connection refused.');
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
