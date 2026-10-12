import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8');

const ACCENTS = ['mint', 'amber', 'rose'];
const TOKENS = [
  '--accent:',
  '--accent-soft:',
  '--accent-line:',
  '--accent-glow:',
  '--accent-line-solid:',
];

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  return css.slice(open, css.indexOf('}', open));
}

describe('accent theme contract', () => {
  it('defines the base accent tokens', () => {
    const base = block(':root {');
    for (const token of TOKENS) expect(base).toContain(token);
  });

  for (const accent of ACCENTS) {
    it(`defines every accent token for ${accent}`, () => {
      const scoped = block(`:root[data-accent='${accent}']`);
      expect(scoped).not.toBe('');
      for (const token of TOKENS) expect(scoped).toContain(token);
    });
  }

  it('binds decorative gradients to the accent, not a fixed palette', () => {
    // A gradient painted from --aurora would ignore the chosen accent, so every
    // accent-dependent surface must reference the accent tokens instead.
    expect(css).not.toMatch(/linear-gradient\([^)]*--aurora/);
  });
});
