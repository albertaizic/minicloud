// Unit tests for automatic-restart backoff math.
import { describe, it, expect } from 'vitest';
import { autoRestartDelayMs } from './engine.js';

describe('autoRestartDelayMs', () => {
  it('grows exponentially from attempt 1', () => {
    expect(autoRestartDelayMs(1)).toBe(4000);
    expect(autoRestartDelayMs(2)).toBe(8000);
    expect(autoRestartDelayMs(3)).toBe(15_000);
  });

  it('caps at 15 seconds so budgets of 10 attempts stay bounded', () => {
    for (let attempt = 4; attempt <= 10; attempt++) {
      expect(autoRestartDelayMs(attempt)).toBe(15_000);
    }
  });
});
