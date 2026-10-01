/**
 * FX for conversion values. Ad platforms get one reporting currency (REPORTING_CURRENCY, USD by
 * default) so values stay comparable across purchases: a floor, a max/min spread or a distinct-value
 * count is only meaningful in one currency. Amounts are never mixed: an amount whose rate is unknown
 * is sent whole in its own currency (the platform converts it) and flagged in_reporting_currency=false.
 *
 * Injectable: FixedFxRates is the test double and the static production option
 * (FX_RATES_TO_REPORTING). A dated source (a BigQuery FX table) implements the same interface.
 */

export interface FxRateProvider {
  /** Units of `to` per 1 unit of `from` on atMs (the purchase time), or null when unknown. */
  rate(from: string, to: string, atMs: number): Promise<number | null>;
}

export class FixedFxRates implements FxRateProvider {
  /**
   * @param reporting   the reporting currency
   * @param toReporting units of the reporting currency per 1 unit of each other currency
   */
  constructor(
    private readonly reporting: string,
    private readonly toReporting: Readonly<Record<string, number>>,
  ) {
    for (const [code, r] of Object.entries(toReporting)) {
      if (!/^[A-Z]{3}$/.test(code) || !(r > 0) || !Number.isFinite(r)) throw new Error(`invalid FX rate for ${code}`);
    }
  }

  async rate(from: string, to: string, _atMs?: number): Promise<number | null> {
    if (from === to) return 1;
    const inReporting = (c: string): number | null => (c === this.reporting ? 1 : (this.toReporting[c] ?? null));
    const a = inReporting(from);
    const b = inReporting(to);
    return a !== null && b !== null ? a / b : null;
  }
}
