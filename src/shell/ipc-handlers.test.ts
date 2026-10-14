import { describe, expect, it } from 'vitest';

import { registerIpcHandlers, type IpcHost } from './ipc-handlers.js';
import { IPC_CHANNELS, type IpcHandler, type IpcRegistrar } from './ipc.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { ControlCenterState } from '../control-center/state.js';

class RecordingRegistrar implements IpcRegistrar {
  readonly handlers = new Map<string, IpcHandler>();
  readonly listeners = new Map<string, (event: unknown, ...args: readonly unknown[]) => void>();
  handle(channel: string, handler: IpcHandler): void {
    this.handlers.set(channel, handler);
  }
  on(channel: string, listener: (event: unknown, ...args: readonly unknown[]) => void): void {
    this.listeners.set(channel, listener);
  }
  invoke(channel: string, ...args: readonly unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    // Mirror ipcMain.handle's (event, ...args) arity so a mis-read argument fails here.
    // The event carries an app frame url: the real handlers refuse any other sender.
    return handler({ senderFrame: { url: 'file:///app/chat.html' } }, ...args);
  }
  emit(channel: string, ...args: readonly unknown[]): void {
    const listener = this.listeners.get(channel);
    if (listener === undefined) throw new Error(`no listener for ${channel}`);
    listener({ senderFrame: { url: 'file:///app/chat.html' } }, ...args);
  }
}

function emptyState(): ControlCenterState {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    account: { state: 'signed_out' },
    voice: {
      catalogState: 'unknown',
      speakResponses: true,
      previewAvailable: false,
      voices: [],
    },
    activation: {
      pushToTalk: {
        enabled: true,
        mode: 'hold',
        key: 'Hold F5',
        globalAccelerator: 'Super+Alt+T',
        globalRegistered: true,
      },
      wakeWord: { enabled: false, phrase: 'hey aria', available: true },
      chatShortcut: { enabled: true, accelerator: 'Super+Alt+A', registered: true },
    },
    ariaConfig: {
      backendBaseUrl: 'https://api.adityamunday.codes',
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
    appearance: { accent: 'aurora', showOrb: true, startOnLogin: false },
    diagnostics: {
      backendState: 'unknown',
      voiceReady: false,
      voiceEngine: 'unavailable',
      listening: false,
      checkedAt: 'x',
      incidents: [],
    },
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
    previewVoice: () => ({ ok: true }),
    signIn: () => ({ ok: false, signedIn: false, reason: 'The session token was rejected.' }),
    signOut: () => ({ ok: true, signedIn: true }),
    beginLogin: () => ({ ok: true, loginUrl: 'https://directioner.com/login', expiresAt: 'x' }),
    awaitLogin: () => ({ ok: true, signedIn: true, reason: 'Signed in.' }),
    cancelLogin: () => undefined,
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
    openChat: () => undefined,
    quit: () => undefined,
    retryShortcuts: () => undefined,
    wakeWordDetected: () => undefined,
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
        IPC_CHANNELS.previewVoice,
        IPC_CHANNELS.accountSignIn,
        IPC_CHANNELS.accountSignOut,
        IPC_CHANNELS.accountBeginLogin,
        IPC_CHANNELS.accountAwaitLogin,
        IPC_CHANNELS.accountCancelLogin,
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
        IPC_CHANNELS.openChat,
        IPC_CHANNELS.shellQuit,
        IPC_CHANNELS.shellRetryShortcuts,
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
    expect(signIn).toEqual({ ok: false, signedIn: false, reason: 'The session token was rejected.' });
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

  it('refuses every channel when the sender is not an app frame', () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, host());
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel === IPC_CHANNELS.wakeWordDetected) {
        const listener = registrar.listeners.get(channel);
        expect(listener).toBeDefined();
        let delivered = 0;
        registerIpcHandlers(
          registrar,
          host({
            wakeWordDetected: () => {
              delivered += 1;
            },
          }),
        );
        const guarded = registrar.listeners.get(channel);
        guarded?.({ senderFrame: { url: 'https://evil.example' } }, { phrase: 'x', confidence: 1 });
        expect(delivered).toBe(0);
        continue;
      }
      const handler = registrar.handlers.get(channel);
      expect(handler).toBeDefined();
      expect(() => handler?.({ senderFrame: { url: 'https://evil.example' } })).toThrow(
        /untrusted sender/,
      );
      expect(() => handler?.({ senderFrame: null })).toThrow(/untrusted sender/);
      expect(() => handler?.({})).toThrow(/untrusted sender/);
    }
  });

  it('routes quit, the shortcut re-grab, and a wake word from a trusted renderer', async () => {
    const registrar = new RecordingRegistrar();
    let quit = 0;
    let retries = 0;
    const detected: unknown[] = [];
    registerIpcHandlers(
      registrar,
      host({
        quit: () => {
          quit += 1;
        },
        retryShortcuts: () => {
          retries += 1;
        },
        wakeWordDetected: (payload) => {
          detected.push(payload);
        },
      }),
    );
    await registrar.invoke(IPC_CHANNELS.shellQuit);
    expect(quit).toBe(1);
    await registrar.invoke(IPC_CHANNELS.shellRetryShortcuts);
    expect(retries).toBe(1);
    registrar.emit(IPC_CHANNELS.wakeWordDetected, {
      phrase: 'hey assistant',
      confidence: 0.97,
      detectorId: 'voxrt',
    });
    expect(detected).toEqual([{ phrase: 'hey assistant', confidence: 0.97, detectorId: 'voxrt' }]);
    registrar.emit(IPC_CHANNELS.wakeWordDetected, { phrase: 'hey assistant' });
    expect(detected).toHaveLength(1);
  });
});
