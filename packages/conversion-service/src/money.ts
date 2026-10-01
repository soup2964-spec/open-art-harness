/**
 * Minor/major currency units. Stripe amounts are integers in the currency's minor unit;
 * ad platforms want decimal major units. Exponents follow Stripe's documented lists of
 * zero-decimal and three-decimal currencies (https://docs.stripe.com/currencies).
 */

const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

function normalizeCurrency(currency: string): string {
  const upper = String(currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) throw new Error(`not an ISO 4217 currency: ${JSON.stringify(currency)}`);
  return upper;
}

export function currencyExponent(currency: string): number {
  const c = normalizeCurrency(currency);
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Round a major amount to the currency's precision (half away from zero). */
export function roundMajor(major: number, currency: string): number {
  if (!Number.isFinite(major)) throw new Error(`amount must be finite (got ${major})`);
  const factor = 10 ** currencyExponent(currency);
  const scaled = Math.round(Math.abs(major) * factor + 1e-9);
  const rounded = scaled / factor;
  return major < 0 ? -rounded : rounded;
}

/** Signed integer minor units -> major units (exact for the currency's precision). */
export function minorToMajor(minor: number, currency: string): number {
  if (!Number.isInteger(minor)) throw new Error(`minor amount must be an integer (got ${minor})`);
  const exponent = currencyExponent(currency);
  return Number((minor / 10 ** exponent).toFixed(exponent));
}

/** Decimal string with exactly the currency's number of fraction digits (LinkedIn wants a string). */
export function formatMajor(major: number, currency: string): string {
  return roundMajor(major, currency).toFixed(currencyExponent(currency));
}
