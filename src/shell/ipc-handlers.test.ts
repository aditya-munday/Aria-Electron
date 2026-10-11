import { describe, expect, it } from 'vitest';

import { registerIpcHandlers, type IpcHost } from './ipc-handlers.js';
import { IPC_CHANNELS, type IpcHandler, type IpcRegistrar } from './ipc.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { ControlCenterState } from '../control-center/state.js';

class RecordingRegistrar implements IpcRegistrar {
  readonly handlers = new Map<string, IpcHandler>();
  handle(channel: string, handler: IpcHandler): void {
    this.handlers.set(channel, handler);
  }
  invoke(channel: string, ...args: readonly unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return handler(...args);
  }
}

function emptyState(): ControlCenterState {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    account: { state: 'signed_out' },
    voice: {
      catalogState: 'unknown',
      speakResponses: true,
      voices: [],
    },
    activation: {
      pushToTalk: { enabled: true, mode: 'hold', key: 'Hold ?' },
      wakeWord: { enabled: false, phrase: 'hey aria', available: true },
      chatShortcut: { enabled: true, accelerator: 'Super+Alt+A' },
    },
    ariaConfig: {
      backendBaseUrl: 'https://api.beyonders.dev',
      requestTimeoutMs: 30000,
      model: { provider: 'groq', id: 'groq/llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B (Groq)', fixed: true },
      options: [],
    },
    privacy: {
      tokenStored: 'memory_only',
      historyRetention: 'opted_out',
      historyRetentionEditable: false,
      notes: [],
    },
    integrations: { backend: { state: 'unknown' }, aiEngineer: { state: 'unknown' } },
    diagnostics: { backendState: 'unknown', voiceReady: false, listening: false, checkedAt: 'x' },
    tasks: [],
  };
}

function host(overrides: Partial<IpcHost> = {}): IpcHost {
  return {
    signedIn: () => false,
    sendText: () => undefined,
    stopPlayback: () => undefined,
    controlCenterState: async () => emptyState(),
    updateSettings: () => ({ ok: true, settings: undefined as never }),
    signIn: () => ({ ok: false, reason: 'unsupported', unsupported: true }),
    signOut: () => ({ ok: true, signedIn: true }),
    orbState: () => ({ generatedAt: 'x', presence: { presence: 'idle', cue: 'dot', label: 'Idle', updatedAt: 'x' } }),
    orbSetInteractive: () => undefined,
    chatState: async () => ({ generatedAt: 'x', turns: [], tasks: [] }),
    decideApproval: () => ({ ok: false, approvalId: '', taskId: '', reason: 'unsupported', reassessmentRequired: false }),
    answerQuestion: () => ({ ok: false, reason: 'unsupported' }),
    decidePlan: () => ({ ok: false, reason: 'unsupported' }),
    decidePermission: () => ({ ok: false, reason: 'unsupported' }),
    cancelTask: () => ({ ok: false, reason: 'unsupported' }),
    muteCapture: () => ({ ok: true, detail: 'Capture muted.' }),
    interruptSpeech: () => ({ ok: true, detail: 'Speech interrupted.' }),
    settings: () => DEFAULT_SETTINGS,
    emergencyStop: () => ({
      engaged: true,
      stopped: [],
      cancellationUnconfirmed: [],
      unknown: [],
      reportedAt: 'x',
    }),
    ...overrides,
  };
}

describe('main-process IPC handlers', () => {
  it('registers exactly the bridge channels and nothing more', () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, host());
    expect([...registrar.handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.status,
        IPC_CHANNELS.sendText,
        IPC_CHANNELS.stopPlayback,
        IPC_CHANNELS.controlCenterState,
        IPC_CHANNELS.settingsUpdate,
        IPC_CHANNELS.accountSignIn,
        IPC_CHANNELS.accountSignOut,
        IPC_CHANNELS.orbState,
        IPC_CHANNELS.orbSetInteractive,
        IPC_CHANNELS.chatState,
        IPC_CHANNELS.chatDecideApproval,
        IPC_CHANNELS.chatAnswerQuestion,
        IPC_CHANNELS.chatDecidePlan,
        IPC_CHANNELS.chatDecidePermission,
        IPC_CHANNELS.chatCancelTask,
        IPC_CHANNELS.chatMuteCapture,
        IPC_CHANNELS.chatInterruptSpeech,
        IPC_CHANNELS.chatEmergencyStop,
        IPC_CHANNELS.shellSettings,
      ].sort(),
    );
  });

  it('reports sign-in state and runtime readiness', async () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, host({ signedIn: () => true }));
    expect(await registrar.invoke(IPC_CHANNELS.status)).toEqual({
      signedIn: true,
      runtime: 'ready',
    });
  });

  it('routes send-text to the host and rejects a non-string argument', async () => {
    const registrar = new RecordingRegistrar();
    const sent: string[] = [];
    registerIpcHandlers(
      registrar,
      host({
        sendText: (text) => {
          sent.push(text);
        },
      }),
    );
    await registrar.invoke(IPC_CHANNELS.sendText, 'ship it');
    expect(sent).toEqual(['ship it']);
    await expect(registrar.invoke(IPC_CHANNELS.sendText, 42)).rejects.toThrow();
  });

  it('routes stop playback to the host', async () => {
    const registrar = new RecordingRegistrar();
    let stopped = 0;
    registerIpcHandlers(
      registrar,
      host({
        stopPlayback: () => {
          stopped += 1;
        },
      }),
    );
    await registrar.invoke(IPC_CHANNELS.stopPlayback);
    expect(stopped).toBe(1);
  });

  it('routes mute capture and speech interrupt through their own channels', async () => {
    const registrar = new RecordingRegistrar();
    const seen: unknown[] = [];
    registerIpcHandlers(
      registrar,
      host({
        muteCapture: (input) => {
          seen.push(input);
          return { ok: true, detail: 'Capture muted.' };
        },
        interruptSpeech: () => {
          seen.push('interrupt');
          return { ok: true, detail: 'Speech interrupted.' };
        },
      }),
    );
    expect(await registrar.invoke(IPC_CHANNELS.chatMuteCapture, { muted: true })).toEqual({
      ok: true,
      detail: 'Capture muted.',
    });
    expect(await registrar.invoke(IPC_CHANNELS.chatInterruptSpeech)).toEqual({
      ok: true,
      detail: 'Speech interrupted.',
    });
    expect(seen).toEqual([{ muted: true }, 'interrupt']);
  });

  it('serves the control-center state on its own channel', async () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, host());
    expect(await registrar.invoke(IPC_CHANNELS.controlCenterState)).toEqual(emptyState());
  });

  it('forwards a settings patch and rejects the unsafe one at the service', async () => {
    const registrar = new RecordingRegistrar();
    const seen: unknown[] = [];
    registerIpcHandlers(
      registrar,
      host({
        updateSettings: (patch) => {
          seen.push(patch);
          return { ok: false, reason: 'Unknown or unsafe settings key.' };
        },
      }),
    );
    const result = await registrar.invoke(IPC_CHANNELS.settingsUpdate, { wakeWordEnabled: true });
    expect(seen).toEqual([{ wakeWordEnabled: true }]);
    expect(result).toEqual({ ok: false, reason: 'Unknown or unsafe settings key.' });
  });

  it('routes sign-in and sign-out through their own channels', async () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, host());
    const signIn = await registrar.invoke(IPC_CHANNELS.accountSignIn, {});
    expect(signIn).toEqual({ ok: false, reason: 'unsupported', unsupported: true });
    const signOut = await registrar.invoke(IPC_CHANNELS.accountSignOut);
    expect(signOut).toEqual({ ok: true, signedIn: true });
  });

  it('never exposes a token or capability channel', () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, host());
    for (const forbidden of ['aria:token', 'aria:capabilities', 'aria:fetch']) {
      expect(registrar.handlers.has(forbidden)).toBe(false);
    }
  });
});
