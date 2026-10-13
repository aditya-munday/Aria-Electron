import { describe, expect, it } from 'vitest';

import {
  ARIA_CONTRACT_VERSION,
  ARIA_PATH_PREFIX,
  isCompatibleVersion,
} from './aria-contract.js';

describe('ARIA contract version', () => {
  it('pins one version and a /v1 prefix', () => {
    expect(ARIA_CONTRACT_VERSION).toBe(1);
    expect(ARIA_PATH_PREFIX).toBe('/v1');
  });
});

describe('isCompatibleVersion', () => {
  it('accepts only the one version this client speaks', () => {
    expect(isCompatibleVersion(ARIA_CONTRACT_VERSION)).toBe(true);
    expect(isCompatibleVersion(2)).toBe(false);
    expect(isCompatibleVersion('1')).toBe(false);
    expect(isCompatibleVersion(undefined)).toBe(false);
  });
});
