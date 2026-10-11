export interface ReportedError {
  readonly at: string;
  readonly source: string;
  readonly message: string;
}

export interface ErrorReporterOptions {
  readonly now?: () => string;
  readonly sink?: (error: ReportedError) => void;
  readonly limit?: number;
}

export class ErrorReporter {
  private readonly now: () => string;
  private readonly sink: (error: ReportedError) => void;
  private readonly limit: number;
  private readonly seen: ReportedError[] = [];

  constructor(options: ErrorReporterOptions = {}) {
    this.now = options.now ?? ((): string => new Date().toISOString());
    this.sink = options.sink ?? ((): void => undefined);
    this.limit = options.limit ?? 50;
  }

  report(source: string, error: unknown): ReportedError {
    const entry: ReportedError = {
      at: this.now(),
      source,
      message: messageOf(error),
    };
    this.seen.push(entry);
    if (this.seen.length > this.limit) this.seen.shift();
    this.sink(entry);
    return entry;
  }

  recent(): readonly ReportedError[] {
    return [...this.seen];
  }

  last(): ReportedError | undefined {
    return this.seen[this.seen.length - 1];
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred.';
}
