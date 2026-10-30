/**
 * Integer minor-unit (paise) money helpers.
 *
 * `docs/SECURITY.md` NFR-SEC-3 forbids floating point arithmetic for currency.
 * Every helper below performs pure integer math and only divides at the very
 * last step, using half-up rounding (`docs/SALARY_RULES.md` §3.2).
 */

export type CurrencyCode = string;

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'AED ',
};

/**
 * Divides two integers applying half-up rounding.
 * Works correctly for negative numerators (rounding away from zero).
 */
export function divideHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new RangeError('divideHalfUp: denominator must not be zero');
  }

  const sign = numerator < 0 ? -1 : 1;
  const absolute = Math.abs(numerator);
  const quotient = Math.floor(absolute / denominator);
  const remainder = absolute % denominator;
  const rounded = remainder * 2 >= denominator ? quotient + 1 : quotient;
  return sign * rounded;
}

/**
 * Multiplies a minor-unit amount by a basis-point factor.
 * `basisPoints` of 15000 means 1.5x, 10000 means 1.0x, 20000 means 2.0x.
 */
export function applyBasisPoints(amountPaise: number, basisPoints: number): number {
  return divideHalfUp(amountPaise * basisPoints, 10_000);
}

/**
 * Computes a prorated amount: `amountPaise * quantity / totalQuantity`.
 * Used by daily-rate proration for half days and monthly-rate daily conversion.
 */
export function prorate(amountPaise: number, quantity: number, totalQuantity: number): number {
  if (totalQuantity <= 0) {
    return 0;
  }
  return divideHalfUp(amountPaise * quantity, totalQuantity);
}

/**
 * Rounds a minor-unit amount to whole currency units (e.g. paise -> rupees).
 */
export function toMajorUnits(amountPaise: number): number {
  return divideHalfUp(amountPaise, 100);
}

/**
 * Formats a minor-unit amount for display. Server-side formatting is only used
 * for legacy fields; the Android client performs its own locale-aware formatting.
 */
export function formatMinorUnits(amountPaise: number, currency: CurrencyCode = 'INR'): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const sign = amountPaise < 0 ? '-' : '';
  const absolute = Math.abs(amountPaise);
  const major = divideHalfUp(absolute, 100);
  const minor = absolute % 100;
  return `${sign}${symbol}${major.toLocaleString('en-IN')}.${String(minor).padStart(2, '0')}`;
}

/**
 * Clamps a value to be non-negative. Deductions and payouts can never be negative.
 */
export function clampNonNegative(value: number): number {
  return value < 0 ? 0 : value;
}
