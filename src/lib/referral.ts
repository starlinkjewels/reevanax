const r2 = (n: number) => Math.round(n * 100) / 100;

/** Commission credited to EACH side (referrer and referee) of a referral pair
 * on one sale — `pct`% of the bill total, capped at `cap`. */
export function computeReferralCommission(billAmount: number, pct: number, cap: number): number {
  return r2(Math.min(Math.max(0, billAmount) * (pct / 100), cap));
}
