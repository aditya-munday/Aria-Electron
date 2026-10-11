import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  InMemorySettingsStore,
  normalizeSettings,
} from './settings.js';

describe('shell settings', () => {
  it('defaults to only the Control Center open', () => {
    expect(DEFAULT_SETTINGS.openWindows).toEqual(['control_center']);
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
});
