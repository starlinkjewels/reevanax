export type ID = string;

export interface Party {
  id: ID;
  name: string;
  type: "customer" | "supplier" | "both";
  phone?: string;
  email?: string;
  gstin?: string;
  address?: string;
  shippingAddress?: string;
  openingBalance: number;
  creditLimit?: number;
  /** Soft-delete flag. An archived party is hidden from new-transaction
   * pickers and the active parties list, but its document is kept so every
   * existing invoice/payment/return, ledger, statement, report and dashboard
   * total that references it stays intact. Absence of the field means active
   * — so every party that predates this feature is active automatically. */
  archived?: boolean;
  /** The party who referred this one, set once at creation and treated as
   * immutable afterward (UI-enforced, not a Firestore rule) — the anchor for
   * every referral-commission calculation on this party's future sales. */
  referredBy?: ID;
  /** Referral wallet — atomic-increment field, same precedent as
   * `Item.stock` / `BankAccount.balance`. Credited on both sides (referrer
   * and referee) whenever a sale accrues a referral commission; never
   * derived from `referral-ledger`, which exists purely as the audit trail. */
  referralWalletBalance?: number;
  createdAt: string;
}

export interface Item {
  id: ID;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit: string;
  hsn?: string;
  gstRate: number;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice?: number;
  stock: number;
  minStock?: number;
  openingStock: number;
  description?: string;
  createdAt: string;
}

export interface LineItem {
  id: ID;
  itemId: ID;
  name: string;
  qty: number;
  unit: string;
  price: number;
  discountPct: number;
  gstRate: number;
  amount: number;
  /** Snapshot of the item's purchase price when the line was created — used for stock-based COGS in P&L */
  costPrice?: number;
  /** Price in the foreign currency, before conversion — only set on
   * international purchases. `price` (INR) is auto-derived from this via
   * the parent Invoice's exchangeRate/carryCostPerUnit, but stays a normal
   * editable field so a cashier can still override the computed value. */
  foreignPrice?: number;
}

export type PaymentMode = "cash" | "bank" | "credit" | "upi" | "cheque";

export interface Invoice {
  id: ID;
  number: string;
  date: string;
  partyId: ID;
  partyName: string;
  partyPhone?: string;
  gstEnabled?: boolean;
  lineItems: LineItem[];
  subtotal: number;
  discount: number;
  /** Flat shipping/freight charge added to the total (sale bills only). */
  shippingCharge?: number;
  taxAmount: number;
  /** Rounding applied to reach a whole-rupee total (e.g. −0.37 or +0.45) */
  roundOff?: number;
  total: number;
  paid: number;
  paymentMode: PaymentMode;
  /** Which bank account `paid` was collected into/from — only set when paymentMode is "bank". */
  bankId?: ID;
  /** Snapshot of `paid` at the moment it was attributed to bankId, so an edit can
   * reverse exactly that amount even if `paid` later grows via Payment allocations. */
  bankPaidAmount?: number;
  /** Purchase bills only — each line's `foreignPrice` (in the supplier's
   * currency) gets converted to INR as `foreignPrice * exchangeRate +
   * carryCostPerUnit`, so the landed per-unit cost (currency conversion +
   * freight/customs, per piece) is baked into the same `price` field
   * everything else (GST, discount, stock costing) already works off. */
  isInternational?: boolean;
  /** 1 unit of the foreign currency, in INR. */
  exchangeRate?: number;
  /** Flat per-piece freight/customs/handling cost, in INR, added on top of
   * the converted price — distinct from `shippingCharge` (a whole-bill
   * flat charge) since this applies per unit, before qty is multiplied in. */
  carryCostPerUnit?: number;
  /** Snapshot of the referral commission this sale last accrued for its
   * party's referrer (see ReferralLedgerEntry) — kept on the invoice itself,
   * exactly like `bankPaidAmount`, so an edit or delete can reverse precisely
   * this amount from both wallets without re-deriving it from the ledger. */
  referralCommission?: number;
  notes?: string;
  createdAt: string;
}

/** Who a referral commission entry credits — the referred party (buyer on
 * this bill) or the party who referred them. */
export type ReferralRole = "referrer" | "referee";

/** One audit-trail row per party credited by a sale's referral commission.
 * Purely a record — the actual payable balance lives on
 * `Party.referralWalletBalance`, an atomic-increment field, so this
 * collection is never summed to derive "what does this party have." */
export interface ReferralLedgerEntry {
  id: ID;
  partyId: ID;
  role: ReferralRole;
  invoiceId: ID;
  invoiceNumber: string;
  /** The other party in this referral pair — the referrer's entry names the
   * referee and vice versa, so each row reads standalone. */
  counterpartyId: ID;
  counterpartyName: string;
  billAmount: number;
  commission: number;
  createdAt: string;
}

/**
 * Who an expense was actually paid to (an employee, landlord, vendor...) —
 * separate from Category (what kind of expense it is), so "how much have I
 * paid Vikas, ever" is answerable without re-deriving it from free text.
 * Deliberately lightweight (no phone/GSTIN/balance like Party) — this is
 * just a name, grown organically as expenses are entered, not a form the
 * user fills out up front.
 */
export interface Payee {
  id: ID;
  name: string;
  /** Pre-fills Category when this payee is picked on a new expense — cuts
   * down on miscategorized entries for a payee that's (almost) always the
   * same kind of spend, e.g. picking "Vikas" always suggesting "Salary". */
  defaultCategory?: string;
  createdAt: string;
}

export interface Expense {
  id: ID;
  date: string;
  category: string;
  amount: number;
  paymentMode: PaymentMode;
  /** Which bank account this was paid from — only set when paymentMode is "bank". */
  bankId?: ID;
  /** Who this was actually paid to — see Payee. Optional on the type so
   * older records saved before this existed still load; the expense form
   * requires it going forward. */
  payeeId?: ID;
  payeeName?: string;
  notes?: string;
  createdAt: string;
}

export interface BankAccount {
  id: ID;
  name: string;
  accountNumber?: string;
  ifsc?: string;
  openingBalance: number;
  balance: number;
  createdAt: string;
}

/** Physical stock correction (damage, counting difference, samples…) */
export interface StockAdjustment {
  id: ID;
  itemId: ID;
  itemName: string;
  date: string;
  type: "add" | "reduce";
  qty: number;
  reason?: string;
  createdAt: string;
}

/** Manual cash-in-hand correction (counter counting, owner drawings…) */
export interface CashAdjustment {
  id: ID;
  date: string;
  type: "add" | "reduce";
  amount: number;
  reason?: string;
  createdAt: string;
}

export interface BankTxn {
  id: ID;
  bankId: ID;
  date: string;
  type: "deposit" | "withdraw" | "transfer";
  amount: number;
  notes?: string;
  createdAt: string;
}

/** How much of a payment was applied to which invoice — needed to reverse
 * invoice.paid when the payment is deleted, and to avoid double counting
 * in ledgers/cash reports. */
export interface PaymentAllocation {
  invoiceId: ID;
  number: string;
  amount: number;
}

export interface Payment {
  id: ID;
  date: string;
  partyId: ID;
  partyName: string;
  type: "in" | "out";
  amount: number;
  mode: PaymentMode;
  /** Which bank account this moved money into/out of — only set when mode is "bank". */
  bankId?: ID;
  ref?: string;
  allocations?: PaymentAllocation[];
  createdAt: string;
}

export interface Return {
  id: ID;
  number: string;
  date: string;
  originalRef?: string;
  partyId: ID;
  partyName: string;
  partyPhone?: string;
  gstEnabled?: boolean;
  lineItems: LineItem[];
  subtotal: number;
  taxAmount: number;
  total: number;
  notes?: string;
  createdAt: string;
}

export type PrintFormat = "a4" | "a4-2up" | "thermal80" | "thermal58";

export interface Company {
  name: string;
  gstin?: string;
  phone?: string;
  email?: string;
  address?: string;
  currency: string;
  invoicePrefix: string;
  purchasePrefix: string;
  enableGst?: boolean;
  /** Round invoice totals to the nearest rupee (default on) */
  enableRoundOff?: boolean;
  /** Allow a sale/purchase-return to push item stock below zero (default on,
   * matching Vyapar/Tally — counter billing shouldn't block on stock entry
   * lagging behind). When turned off, such saves are blocked with an error
   * instead of just a warning. */
  allowNegativeStock?: boolean;
  /** Preferred print format, remembered from the invoice page */
  printFormat?: PrintFormat;
  /** Referral commission scheme (default off). When on, a Sale for a party
   * with `referredBy` set credits both that party and their referrer
   * `referralPercent`% of the bill total each, capped at `referralMaxPerBill`. */
  referralEnabled?: boolean;
  /** Percent of the bill total credited to EACH side (referrer and referee),
   * not split between them. Defaults to 10 when unset. */
  referralPercent?: number;
  /** Per-bill cap on the commission credited to each side. Defaults to 500 when unset. */
  referralMaxPerBill?: number;
  /** The expense Category list — admin-managed from Settings, like a real
   * Chart of Accounts, rather than free text every user can invent on the
   * fly. Kept on Company (not its own repository) since it's a short,
   * stable list, unlike Payee which is meant to grow organically. */
  expenseCategories?: string[];
}

/** Matches the Sidebar's own groupings — permissions are granted per group,
 * not per individual page and not as fixed roles. Settings/Team management
 * is deliberately NOT a module here: it's owner-only everywhere, always,
 * so a staff member can never grant themselves broader access by editing
 * their own permissions. "reports" has no collection of its own (Reports/
 * Daybook/GST aggregate reads across the other modules, already protected
 * by their own rules) — it only gates the aggregated-view pages themselves. */
export type ModuleKey = "masterData" | "sales" | "purchaseExpenses" | "cashBank" | "reports";

export interface ModulePermission {
  view: boolean;
  edit: boolean;
  delete: boolean;
}

/** One doc per Firebase Auth UID. The account already using this app in
 * production becomes `isOwner: true` automatically the first time it loads
 * after this ships (see hydrateRepos) — existing behavior is unaffected. */
export interface TeamUser {
  id: string;
  email: string;
  name: string;
  /** Bypasses every permission check everywhere. Exactly one per business —
   * cannot be edited or deactivated by anyone, including another owner. */
  isOwner: boolean;
  /** false = fully locked out (deactivated, not deleted — see Settings/Team). */
  active: boolean;
  /** A module missing from this map means no access at all to it, not
   * "view only" — every level must be explicitly granted. */
  permissions: Partial<Record<ModuleKey, ModulePermission>>;
  createdAt: string;
}
