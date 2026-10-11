import { describe, expect, it } from 'vitest';

import { deriveTitle, operationForRoute, shouldSubmit } from './submission.js';

describe('shouldSubmit', () => {
  it('submits only when the route hint explicitly requires confirmation', () => {
    expect(shouldSubmit({ capability: 'deploy.service', requires_confirmation: true })).toBe(true);
  });

  it('does not submit an advisory route that does not require confirmation', () => {
    expect(shouldSubmit({ capability: 'chat', requires_confirmation: false })).toBe(false);
  });

  it('does not submit when there is no route hint at all', () => {
    expect(shouldSubmit(undefined)).toBe(false);
    expect(shouldSubmit(null)).toBe(false);
  });
});

describe('deriveTitle', () => {
  it('uses the user\u2019s own words, collapsing whitespace', () => {
    expect(deriveTitle('  deploy   the\n api  ')).toBe('deploy the api');
  });

  it('falls back to a neutral title for empty input', () => {
    expect(deriveTitle('   ')).toBe('Engineering request');
  });

  it('bounds the title length', () => {
    const title = deriveTitle('x'.repeat(500));
    expect(title.length).toBeLessThanOrEqual(200);
  });
});

describe('operationForRoute', () => {
  it('describes only the capability the hint carried, with no invented scope', () => {
    const operation = operationForRoute({ capability: 'deploy.service' });
    expect(operation.capability).toBe('deploy.service');
    expect(operation.parameters).toEqual({});
    expect(operation.affectedResources).toEqual([]);
  });
});
