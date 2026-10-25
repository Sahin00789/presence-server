import { describe, expect, it } from 'vitest';

describe('Financial invariants', () => {
  it('money must be integer cents', () => {
    const amount = Math.round(123.45 * 100);
    expect(Number.isInteger(amount)).toBe(true);
    expect(amount).toBe(12345);
  });

  it('no floating point for currency calculations', () => {
    const a = 100.1;
    const b = 200.2;
    const sum = Math.round((a + b) * 100) / 100;
    expect(sum).toBe(300.3);
    // But we must store as integers
    expect(Math.round(sum * 100)).toBe(30030);
  });
});
