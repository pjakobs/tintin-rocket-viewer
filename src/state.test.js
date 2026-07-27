import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseHash, debounceWithMaxWait } from './state.js';

// parseHash reads the global `location`, which Node doesn't provide — stub
// just enough of it rather than pulling in jsdom for one property.
function setHash(hash) {
  vi.stubGlobal('location', { hash });
}

describe('parseHash', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns an empty object for an empty hash', () => {
    setHash('');
    expect(parseHash()).toEqual({});
  });

  it('strips the leading #', () => {
    setHash('#e=40&s=180');
    expect(parseHash()).toEqual({ e: '40', s: '180' });
  });

  it('ignores a key with no "="', () => {
    setHash('#e=40&garbage&s=180');
    expect(parseHash()).toEqual({ e: '40', s: '180' });
  });

  it('drops a pair with no key, but keeps one with an empty value', () => {
    setHash('#=40&s=&p=612');
    expect(parseHash()).toEqual({ s: '', p: '612' });
  });
});

describe('debounceWithMaxWait', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once, after `wait`, following a single call', () => {
    const fn = vi.fn();
    const debounced = debounceWithMaxWait(fn, 350, 600);
    debounced();
    vi.advanceTimersByTime(349);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('caps the wait at maxWait since the first call, even under continuous re-triggering', () => {
    const fn = vi.fn();
    const debounced = debounceWithMaxWait(fn, 100, 300);
    debounced(); // t=0
    // Re-trigger every 50ms — shorter than `wait` (100ms), so a plain debounce
    // would never fire on its own.
    for (const elapsed of [50, 50, 50, 50, 50]) { // t=50,100,150,200,250
      vi.advanceTimersByTime(elapsed);
      debounced();
    }
    expect(fn).not.toHaveBeenCalled(); // 250ms elapsed since the first call
    vi.advanceTimersByTime(50); // t=300: maxWait since the first call is up
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
