import { describe, expect, it } from 'vitest';

import { ErrorReporter } from './error-reporting.js';

describe('ErrorReporter', () => {
  it('records an error with its source and a stable message', () => {
    const reporter = new ErrorReporter({ now: () => 't0' });
    const entry = reporter.report('renderer:chat', new Error('load failed'));
    expect(entry).toEqual({ at: 't0', source: 'renderer:chat', message: 'load failed' });
    expect(reporter.last()).toEqual(entry);
  });

  it('normalizes a non-Error reason rather than losing it', () => {
    const reporter = new ErrorReporter();
    expect(reporter.report('unhandledRejection', 'boom').message).toBe('boom');
    expect(reporter.report('uncaughtException', 42).message).toBe('An unexpected error occurred.');
  });

  it('forwards every entry to the sink', () => {
    const seen: string[] = [];
    const reporter = new ErrorReporter({ sink: (entry) => seen.push(entry.source) });
    reporter.report('a', new Error('x'));
    reporter.report('b', new Error('y'));
    expect(seen).toEqual(['a', 'b']);
  });

  it('keeps only the most recent entries up to the limit', () => {
    const reporter = new ErrorReporter({ limit: 2 });
    reporter.report('a', new Error('1'));
    reporter.report('b', new Error('2'));
    reporter.report('c', new Error('3'));
    expect(reporter.recent().map((entry) => entry.source)).toEqual(['b', 'c']);
  });
});
