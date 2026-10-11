import { describe, expect, it } from 'vitest';

import { createControlCenterRuntime } from './control-center-runtime.js';
import { ErrorReporter } from '../shell/error-reporting.js';
import type { AriaRuntime } from '../runtime.js';
import type { AriaShell } from '../shell/aria-shell.js';

function runtimeWith(errors: ErrorReporter) {
  return createControlCenterRuntime(
    {} as unknown as AriaRuntime,
    {} as unknown as AriaShell,
    errors,
  );
}

describe('createControlCenterRuntime.incidents', () => {
  it('lists reported errors newest first', () => {
    let tick = 0;
    const errors = new ErrorReporter({ now: () => `t${tick++}` });
    errors.report('first', new Error('one'));
    errors.report('second', new Error('two'));

    expect(runtimeWith(errors).incidents()).toEqual([
      { at: 't1', source: 'second', message: 'two' },
      { at: 't0', source: 'first', message: 'one' },
    ]);
  });

  it('is empty when nothing has been reported', () => {
    expect(runtimeWith(new ErrorReporter()).incidents()).toEqual([]);
  });
});
