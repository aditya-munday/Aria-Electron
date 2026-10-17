import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIDECAR_WAKE_MODELS,
  SidecarWakeEngine,
  createSidecarWakeWordDetector,
} from './sidecar-wake-detector.js';
import { SidecarSupervisor, type SidecarChild, type SidecarSpawn } from './sidecar-supervisor.js';
import { SIDECAR_PROTOCOL_VERSION, encodeJsonFrame } from './sidecar-protocol.js';

type Listener = (...args: never[]) => void;

class FakeChild implements SidecarChild {
  private readonly dataListeners: ((chunk: Buffer) => void)[] = [];
  private readonly closeListeners: ((code: number | null) => void)[] = [];
  readonly stdinData: Buffer[] = [];
  readonly stdin = {
    write: (data: Uint8Array): void => {
      this.stdinData.push(Buffer.from(data));
    },
    end: (): void => undefined,
    on: (_event: 'error', _listener: (error: Error) => void): void => undefined,
  };
  readonly stdout = {
    on: (event: 'data', listener: (chunk: Buffer) => void): void => {
      if (event === 'data') this.dataListeners.push(listener);
    },
  };
  readonly stderr = { on: (): void => undefined };

  on(event: 'error' | 'close', listener: Listener): void {
    if (event === 'close') this.closeListeners.push(listener as (code: number | null) => void);
  }

  kill(): boolean {
    return true;
  }

  emit(frame: unknown): void {
    const bytes = encodeJsonFrame(frame);
    for (const listener of this.dataListeners) listener(bytes);
  }
}

function makeSupervisor(child: FakeChild): { supervisor: SidecarSupervisor; spawn: SidecarSpawn } {
  const spawn: SidecarSpawn = () => child;
  const supervisor = new SidecarSupervisor({
    command: 'aria-voice',
    spawn,
    sleep: () => Promise.resolve(),
  });
  return { supervisor, spawn };
}

describe('SidecarWakeEngine', () => {
  it('defaults to the bundled alexa model', () => {
    expect(DEFAULT_SIDECAR_WAKE_MODELS).toEqual(['alexa_v0.1']);
  });

  it('starts the supervisor, configures the models, and arms listening', async () => {
    const child = new FakeChild();
    const { supervisor } = makeSupervisor(child);
    const engine = new SidecarWakeEngine({ command: 'aria-voice', supervisor });
    const init = engine.init();
    child.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    await init;

    const sent = Buffer.concat(child.stdinData).toString('utf8');
    expect(sent).toContain('configure');
    expect(sent).toContain('alexa_v0.1');
    expect(sent).toContain('arm_listen');
  });

  it('maps a wake event to a detection and drains one per process call', async () => {
    const child = new FakeChild();
    const { supervisor } = makeSupervisor(child);
    const engine = new SidecarWakeEngine({ command: 'aria-voice', supervisor });
    const init = engine.init();
    child.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    await init;

    expect(engine.process()).toBeUndefined();
    child.emit({ event: 'wake', model: 'alexa_v0.1', score: 0.91 });
    child.emit({ event: 'wake', model: 'alexa_v0.1', score: 0.77 });
    expect(engine.process()).toEqual({ phrase: 'alexa_v0.1', confidence: 0.91 });
    expect(engine.process()).toEqual({ phrase: 'alexa_v0.1', confidence: 0.77 });
    expect(engine.process()).toBeUndefined();
  });

  it('exposes a detector whose model is the configured wake model', async () => {
    const child = new FakeChild();
    const { supervisor } = makeSupervisor(child);
    const detector = createSidecarWakeWordDetector({ command: 'aria-voice', supervisor });
    const init = detector.init();
    child.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    await init;
    expect(detector.status()).toBe('ready');
    expect(detector.model()).toBe('alexa_v0.1');
  });

  it('fails observably when the sidecar never becomes ready', async () => {
    const child = new FakeChild();
    const { supervisor } = makeSupervisor(child);
    const detector = createSidecarWakeWordDetector({ command: 'aria-voice', supervisor });
    const init = detector.init();
    child.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION + 1 });
    await expect(init).rejects.toThrow(/protocol/);
    expect(detector.status()).toBe('failed');
    expect(detector.failure()).toMatch(/protocol/);
  });
});
