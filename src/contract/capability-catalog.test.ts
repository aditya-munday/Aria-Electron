import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_CATALOG,
  CAPABILITY_CATALOG_VERSION,
  resolveCapabilityCatalog,
  type CapabilityEnvironment,
} from './capability-catalog.js';

function env(overrides: Partial<CapabilityEnvironment> = {}): CapabilityEnvironment {
  return {
    voiceEngine: true,
    wakeWord: true,
    backend: true,
    signedIn: true,
    platform: 'linux',
    ...overrides,
  };
}

function entry(id: string, overrides: Partial<CapabilityEnvironment> = {}) {
  return resolveCapabilityCatalog(env(overrides)).find((c) => c.id === id);
}

describe('capability catalog', () => {
  it('is versioned and non-empty', () => {
    expect(CAPABILITY_CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CAPABILITY_CATALOG.length).toBeGreaterThan(0);
  });

  it('gives every capability a unique id and machine-readable metadata', () => {
    const ids = CAPABILITY_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const capability of CAPABILITY_CATALOG) {
      expect(capability.id).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(capability.sideEffects).toBeInstanceOf(Array);
      expect(capability.recovery.length).toBeGreaterThan(0);
    }
  });

  it('marks every capability supported on a fully capable build', () => {
    const resolved = resolveCapabilityCatalog(env());
    expect(resolved.every((c) => c.supported)).toBe(true);
    expect(resolved.every((c) => c.reason === undefined)).toBe(true);
  });

  it('reports push to talk unsupported without a voice engine, with a reason', () => {
    const capability = entry('voice.push_to_talk', { voiceEngine: false });
    expect(capability?.supported).toBe(false);
    expect(capability?.reason).toMatch(/microphone/i);
  });

  it('reports wake word unsupported when no detector exists, but push to talk stays supported', () => {
    const wake = entry('voice.wake_word', { wakeWord: false });
    const ptt = entry('voice.push_to_talk', { wakeWord: false });
    expect(wake?.supported).toBe(false);
    expect(wake?.reason).toMatch(/wake-word detector/i);
    expect(ptt?.supported).toBe(true);
  });

  it('reports tracked-work capabilities unsupported while signed out', () => {
    expect(entry('task.submit', { signedIn: false })?.supported).toBe(false);
    expect(entry('task.submit', { signedIn: false })?.reason).toMatch(/sign in/i);
  });

  it('reports tracked-work capabilities unsupported when the Backend is unreachable', () => {
    const capability = entry('task.submit', { backend: false });
    expect(capability?.supported).toBe(false);
    expect(capability?.reason).toMatch(/backend/i);
  });

  it('reports autostart unsupported off Linux', () => {
    expect(entry('desktop.autostart', { platform: 'darwin' })?.supported).toBe(false);
    expect(entry('desktop.autostart')?.supported).toBe(true);
  });

  it('keeps emergency stop supported even when the Backend is down and signed out', () => {
    const capability = entry('control.emergency_stop', { backend: false, signedIn: false });
    expect(capability?.supported).toBe(true);
  });

  it('carries the approval and verification policy for privileged operations', () => {
    const approve = entry('task.approve');
    expect(approve?.approval).toBe('per_operation');
    expect(approve?.risk).toBe('high');
    expect(approve?.reversible).toBe(false);
  });
});
