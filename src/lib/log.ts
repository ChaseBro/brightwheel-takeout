// Ring-buffer logger. Used everywhere instead of `console.log`.
//
// - Keeps only the last N lines in memory (so long runs don't blow the SW heap).
// - Mirrors to `console` in dev (via `mirrorToConsole`), silent in prod.
// - Dumped into the ZIP as `takeout.log` at end of run.

const DEFAULT_CAPACITY = 500;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  ts: number;
  level: LogLevel;
  msg: string;
}

export class RingLogger {
  private buffer: LogLine[] = [];
  private capacity: number;
  mirrorToConsole: boolean;

  constructor(opts: { capacity?: number; mirrorToConsole?: boolean } = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.mirrorToConsole = opts.mirrorToConsole ?? false;
  }

  private push(level: LogLevel, msg: string): void {
    const line: LogLine = { ts: Date.now(), level, msg };
    this.buffer.push(line);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    if (this.mirrorToConsole) {
      const fn =
        level === 'error'
          ? console.error
          : level === 'warn'
            ? console.warn
            : level === 'debug'
              ? console.debug
              : console.log;
      fn.call(console, `[bw-takeout ${level}]`, msg);
    }
  }

  debug(msg: string): void {
    this.push('debug', msg);
  }
  info(msg: string): void {
    this.push('info', msg);
  }
  warn(msg: string): void {
    this.push('warn', msg);
  }
  error(msg: string): void {
    this.push('error', msg);
  }

  lines(): LogLine[] {
    return this.buffer.slice();
  }

  toText(): string {
    return this.buffer
      .map((l) => `${new Date(l.ts).toISOString()} ${l.level.padEnd(5)} ${l.msg}`)
      .join('\n');
  }

  clear(): void {
    this.buffer = [];
  }

  /**
   * Grow (or shrink) the ring capacity. Used by Debug mode to lift the cap
   * from the default (500) so we can keep more lines during a long run
   * without dropping early diagnostics.
   */
  setCapacity(cap: number): void {
    this.capacity = cap;
    if (this.buffer.length > cap) {
      this.buffer.splice(0, this.buffer.length - cap);
    }
  }
}

// A shared singleton for convenience. Modules that want independent buffers
// can construct their own RingLogger.
export const log = new RingLogger();
