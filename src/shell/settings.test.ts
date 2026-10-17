import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  InMemorySettingsStore,
  normalizeSettings,
  patchSettings,
} from './settings.js';

describe('shell settings', () => {
  it('defaults to only the Control Center open', () => {
    expect(DEFAULT_SETTINGS.openWindows).toEqual(['control_center']);
  });

  it('leaves the Orb transient by default so it only pins when asked', () => {
    expect(DEFAULT_SETTINGS.showOrb).toBe(false);
  });

  it('keeps the microphone and autostart off until the user opts in', () => {
    expect(DEFAULT_SETTINGS.wakeWordEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.startOnLogin).toBe(false);
  });

  it('falls back to defaults for a non-object payload', () => {
    expect(normalizeSettings(null)).toEqual({ ...DEFAULT_SETTINGS });
    expect(normalizeSettings('nope')).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('drops unknown window kinds from a persisted list', () => {
    const settings = normalizeSettings({ openWindows: ['control_center', 'bogus'] });
    expect(settings.openWindows).toEqual(['control_center']);
  });

  it('omits an empty capture device id', () => {
    const settings = normalizeSettings({ captureDeviceId: '   ' });
    expect(settings.captureDeviceId).toBeUndefined();
    expect('captureDeviceId' in settings).toBe(false);
  });

  it('round-trips through the in-memory store', () => {
    const store = new InMemorySettingsStore();
    store.save({ ...DEFAULT_SETTINGS, wakeWordEnabled: true });
    expect(store.load().wakeWordEnabled).toBe(true);
  });

  it('defaults capture to unmuted and validates a persisted mute flag', () => {
    expect(DEFAULT_SETTINGS.captureMuted).toBe(false);
    expect(normalizeSettings({ captureMuted: true }).captureMuted).toBe(true);
    expect(normalizeSettings({ captureMuted: 'yes' }).captureMuted).toBe(false);
  });

  it('applies a capture-mute patch without disturbing unrelated settings', () => {
    const patched = patchSettings(
      { ...DEFAULT_SETTINGS, wakeWordEnabled: true },
      { captureMuted: true },
    );
    expect(patched.captureMuted).toBe(true);
    expect(patched.wakeWordEnabled).toBe(true);
  });

  it('notifies subscribers on save and stops after unsubscribe', () => {
    const store = new InMemorySettingsStore();
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe?.((next) => seen.push(next.wakeWordEnabled)) ?? (() => undefined);
    store.save({ ...DEFAULT_SETTINGS, wakeWordEnabled: true });
    unsubscribe();
    store.save({ ...DEFAULT_SETTINGS, wakeWordEnabled: false });
    expect(seen).toEqual([true]);
  });

});
