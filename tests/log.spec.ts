import { describe, expect, it } from 'vitest';
import { RingLogger } from '@/lib/log';

describe('RingLogger', () => {
  it('keeps only the last N lines', () => {
    const log = new RingLogger({ capacity: 3 });
    log.info('a');
    log.info('b');
    log.info('c');
    log.info('d');
    const lines = log.lines().map((l) => l.msg);
    expect(lines).toEqual(['b', 'c', 'd']);
  });

  it('toText renders ISO timestamps and levels', () => {
    const log = new RingLogger({ capacity: 5 });
    log.warn('careful');
    log.error('boom');
    const txt = log.toText();
    expect(txt).toMatch(/warn/);
    expect(txt).toMatch(/error/);
    expect(txt).toMatch(/careful/);
    expect(txt).toMatch(/boom/);
  });

  it('clear empties the buffer', () => {
    const log = new RingLogger();
    log.info('x');
    log.clear();
    expect(log.lines()).toEqual([]);
  });
});
