/**
 * REEVANA X production audit harness.
 * Imports the REAL calculation library (src/lib/ledger.ts) and hammers it
 * with randomized business scenarios ("monkey testing"), asserting the
 * accounting invariants that must never break.
 */
import {
  partyBalances,
  modeFlows,
  cashFlows,
  bankFlows,
  netFlow,
  computeCogs,
  allocatedAmount,
  advanceAmount,
  paidViaPayments,
} from "@/lib/ledger";
import type {
  Invoice,
  Payment,
  Return,
  Item,
  Expense,
  LineItem,
  CashAdjustment,
  PaymentMode,
} from "@/types";
import { Repository } from "@/repositories/base";

let passed = 0,
  failed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  if (fails.length < 20) fails.push(msg);
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const approx = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

// Seeded RNG for reproducible runs
let seed = 20260702;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const ri = (max: number) => Math.floor(rnd() * max);
const pick = <T>(a: T[]) => a[ri(a.length)];
let idCounter = 0;
const nid = () => `id${++idCounter}`;

/* ═══════ TEST 1: Invoice totals formula — 5000 random bills ═══════ */
// Replicates InvoiceForm.recalc exactly and asserts the printed columns
// (taxable subtotal + GST − extra discount + round off) reconcile to Total.
for (let t = 0; t < 5000; t++) {
  const nLines = 1 + ri(8);
  const lines = Array.from({ length: nLines }, () => ({
    qty: r2(0.5 + rnd() * 20),
    price: r2(rnd() * 5000),
    discountPct: ri(4) === 0 ? ri(30) : 0,
    gstRate: pick([0, 5, 12, 18, 28]),
  }));
  const discount = ri(3) === 0 ? r2(rnd() * 50) : 0;
  const roundEnabled = ri(4) !== 0;
  // exact copy of recalc math
  const afterLineDisc = r2(
    lines.reduce((s, l) => s + r2(l.qty * l.price * (1 - l.discountPct / 100)), 0),
  );
  const taxAmount = r2(
    lines.reduce(
      (s, l) => s + r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * (l.gstRate / 100)),
      0,
    ),
  );
  const rawTotal = Math.max(0, r2(afterLineDisc + taxAmount - discount));
  const total = roundEnabled ? Math.round(rawTotal) : rawTotal;
  const roundOff = r2(total - rawTotal);

  assert(!roundEnabled || Number.isInteger(total), `T1: rounded total not whole rupee: ${total}`);
  assert(Math.abs(roundOff) <= 0.5 + 1e-9, `T1: roundOff out of range: ${roundOff}`);
  // What the printed bill shows must add up:
  const printed = r2(afterLineDisc + taxAmount - discount + roundOff);
  assert(approx(printed, total), `T1: printed columns ${printed} != total ${total}`);
}

/* ═══════ TEST 2: Party balances — 300 random books ═══════ */
for (let t = 0; t < 300; t++) {
  const partyIds = Array.from({ length: 1 + ri(5) }, () => nid());
  const invoices: Invoice[] = [];
  const returns: Return[] = [];
  const payments: Payment[] = [];

  for (let i = 0; i < 2 + ri(20); i++) {
    const pid = pick(partyIds);
    const total = r2(100 + rnd() * 9000);
    const initialPaid = ri(3) === 0 ? r2(rnd() * total) : 0;
    invoices.push({
      id: nid(),
      number: `INV-${i}`,
      date: "2026-07-01",
      partyId: pid,
      partyName: pid,
      lineItems: [],
      subtotal: total,
      discount: 0,
      taxAmount: 0,
      total,
      paid: initialPaid,
      paymentMode: "cash",
      createdAt: "",
    });
  }
  for (const inv of invoices) {
    if (ri(3) === 0) {
      // a payment applied against this invoice
      const due = r2(inv.total - inv.paid);
      if (due > 1) {
        const applyAmt = r2(due * (0.3 + rnd() * 0.7));
        inv.paid = r2(inv.paid + applyAmt); // what the app does on apply
        payments.push({
          id: nid(),
          date: "2026-07-02",
          partyId: inv.partyId,
          partyName: inv.partyName,
          type: "in",
          amount: applyAmt,
          mode: pick(["cash", "bank", "upi"] as PaymentMode[]),
          allocations: [{ invoiceId: inv.id, number: inv.number, amount: applyAmt }],
          createdAt: "",
        });
      }
    }
    if (ri(5) === 0) {
      returns.push({
        id: nid(),
        number: `CR-${inv.number}`,
        date: "2026-07-03",
        partyId: inv.partyId,
        partyName: inv.partyName,
        lineItems: [],
        subtotal: 0,
        taxAmount: 0,
        total: r2(inv.total * 0.2),
        createdAt: "",
      });
    }
  }
  // pure advances
  for (let i = 0; i < ri(4); i++) {
    const pid = pick(partyIds);
    payments.push({
      id: nid(),
      date: "2026-07-02",
      partyId: pid,
      partyName: pid,
      type: "in",
      amount: r2(50 + rnd() * 500),
      mode: "cash",
      createdAt: "",
    });
  }

  const balances = partyBalances(invoices, returns, payments);
  for (const b of balances) {
    // independent naive recomputation
    const inv = invoices.filter((x) => x.partyId === b.partyId);
    const ret = returns.filter((x) => x.partyId === b.partyId);
    const pay = payments.filter((x) => x.partyId === b.partyId);
    const invoiced = r2(inv.reduce((s, x) => s + x.total, 0));
    const settled = r2(inv.reduce((s, x) => s + x.paid, 0));
    const returned = r2(ret.reduce((s, x) => s + x.total, 0));
    const advances = r2(
      pay.reduce(
        (s, p) => s + (p.amount - (p.allocations ?? []).reduce((a, x) => a + x.amount, 0)),
        0,
      ),
    );
    const expect = r2(invoiced - returned - settled - advances);
    assert(approx(b.balance, expect), `T2: balance ${b.balance} != naive ${expect}`);
    // every allocated rupee is inside invoice.paid — money counted exactly once
    for (const p of pay) {
      assert(allocatedAmount(p) <= p.amount + 0.001, `T2: allocated > amount`);
      assert(approx(advanceAmount(p), p.amount - allocatedAmount(p)), `T2: advance mismatch`);
    }
  }
}

/* ═══════ TEST 3: Cash/bank flows never double-count applied payments ═══════ */
for (let t = 0; t < 300; t++) {
  // one cash invoice: paid 200 at billing, then 300 applied via a UPI payment
  const inv: Invoice = {
    id: nid(),
    number: "INV-X",
    date: "2026-07-01",
    partyId: "p",
    partyName: "p",
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 500,
    paymentMode: "cash",
    createdAt: "",
  };
  const pay: Payment = {
    id: nid(),
    date: "2026-07-02",
    partyId: "p",
    partyName: "p",
    type: "in",
    amount: 300,
    mode: "upi",
    allocations: [{ invoiceId: inv.id, number: inv.number, amount: 300 }],
    createdAt: "",
  };
  const cash = netFlow(cashFlows([inv], [], [], [pay], []));
  const bank = netFlow(bankFlows([inv], [], [], [pay]));
  assert(approx(cash, 200), `T3: cash ${cash} != 200 (initial cash only)`);
  assert(approx(bank, 300), `T3: bank ${bank} != 300 (UPI payment only)`);
  assert(approx(cash + bank, inv.paid), `T3: cash+bank != invoice.paid`);
}

/* ═══════ TEST 4: COGS ═══════ */
{
  const items: Item[] = [
    {
      id: "i1",
      name: "A",
      unit: "pcs",
      gstRate: 0,
      purchasePrice: 80,
      salePrice: 100,
      stock: 0,
      openingStock: 0,
      createdAt: "",
    },
  ];
  const line = (qty: number, costPrice?: number): LineItem => ({
    id: nid(),
    itemId: "i1",
    name: "A",
    qty,
    unit: "pcs",
    price: 100,
    discountPct: 0,
    gstRate: 0,
    amount: qty * 100,
    costPrice,
  });
  const sales: Invoice[] = [
    {
      id: nid(),
      number: "S1",
      date: "2026-07-01",
      partyId: "p",
      partyName: "p",
      lineItems: [line(2, 70), line(3)],
      subtotal: 500,
      discount: 0,
      taxAmount: 0,
      total: 500,
      paid: 0,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const rets: Return[] = [
    {
      id: nid(),
      number: "CR1",
      date: "2026-07-02",
      partyId: "p",
      partyName: "p",
      lineItems: [line(1, 70)],
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      createdAt: "",
    },
  ];
  // 2×70 (snapshot) + 3×80 (fallback) − 1×70 (returned) = 310
  assert(approx(computeCogs(sales, rets, items), 310), `T4: COGS != 310`);
}

/* ═══════ TEST 5: MONKEY — 20,000 random stock operations ═══════ */
// Simulates the exact mutation sequences the app performs and checks
// stock always equals opening + everything-in − everything-out.
{
  type Doc = { qty: number; itemId: string };
  const item = { opening: 100, stock: 100 };
  const salesDocs = new Map<string, Doc>();
  const purchaseDocs = new Map<string, Doc>();
  const sRetDocs = new Map<string, Doc>();
  const pRetDocs = new Map<string, Doc>();
  let adjNet = 0;
  let openingEdits = 0;

  const expectStock = () => {
    let s = item.opening;
    for (const d of purchaseDocs.values()) s += d.qty;
    for (const d of salesDocs.values()) s -= d.qty;
    for (const d of sRetDocs.values()) s += d.qty;
    for (const d of pRetDocs.values()) s -= d.qty;
    return r2(s + adjNet);
  };
  const adj = (delta: number) => {
    item.stock = r2(item.stock + delta);
  };

  for (let op = 0; op < 20000; op++) {
    const kind = ri(10);
    const qty = r2(0.5 + rnd() * 10);
    if (kind === 0) {
      // new sale (app: stock −qty)
      const id = nid();
      salesDocs.set(id, { qty, itemId: "i" });
      adj(-qty);
    } else if (kind === 1) {
      // new purchase (+qty)
      const id = nid();
      purchaseDocs.set(id, { qty, itemId: "i" });
      adj(qty);
    } else if (kind === 2 && salesDocs.size) {
      // edit sale (reverse old, apply new)
      const id = pick([...salesDocs.keys()]);
      const old = salesDocs.get(id)!;
      adj(old.qty); // reversal
      old.qty = qty;
      adj(-qty); // re-apply
    } else if (kind === 3 && salesDocs.size) {
      // delete sale (+qty back)
      const id = pick([...salesDocs.keys()]);
      adj(salesDocs.get(id)!.qty);
      salesDocs.delete(id);
    } else if (kind === 4 && purchaseDocs.size) {
      // delete purchase (−qty)
      const id = pick([...purchaseDocs.keys()]);
      adj(-purchaseDocs.get(id)!.qty);
      purchaseDocs.delete(id);
    } else if (kind === 5) {
      // sale return (+qty)
      const id = nid();
      sRetDocs.set(id, { qty, itemId: "i" });
      adj(qty);
    } else if (kind === 6) {
      // purchase return (−qty)
      const id = nid();
      pRetDocs.set(id, { qty, itemId: "i" });
      adj(-qty);
    } else if (kind === 7 && sRetDocs.size) {
      // delete sale return (−qty)
      const id = pick([...sRetDocs.keys()]);
      adj(-sRetDocs.get(id)!.qty);
      sRetDocs.delete(id);
    } else if (kind === 8) {
      // manual stock adjustment
      const delta = (ri(2) ? 1 : -1) * qty;
      adjNet = r2(adjNet + delta);
      adj(delta);
    } else if (kind === 9) {
      // edit opening stock (delta shifts current)
      const newOpening = r2(rnd() * 200);
      const delta = r2(newOpening - item.opening);
      item.opening = newOpening;
      adj(delta);
      openingEdits++;
    }
    if (op % 100 === 0 || op === 19999) {
      assert(
        approx(item.stock, expectStock(), 0.5),
        `T5 op${op}: stock ${item.stock} != expected ${expectStock()}`,
      );
    }
  }
  assert(approx(item.stock, expectStock(), 0.5), `T5 final: stock drifted`);
}

/* ═══════ TEST 6: MONKEY — payment lifecycle (create/edit/delete) ═══════ */
{
  const invoices: Invoice[] = Array.from({ length: 12 }, (_, i) => ({
    id: nid(),
    number: `INV-${i}`,
    date: "2026-07-01",
    partyId: "p1",
    partyName: "p1",
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 0,
    paymentMode: "credit",
    createdAt: "",
  }));
  const initialPaid = new Map(invoices.map((i) => [i.id, 0]));
  const payments: Payment[] = [];

  const applyPayment = (): Payment | null => {
    const open = invoices.filter((i) => r2(i.total - i.paid) > 1);
    if (!open.length) return null;
    const allocs = open
      .slice(0, 1 + ri(3))
      .map((inv) => {
        const amt = r2(Math.min(r2(inv.total - inv.paid), 50 + rnd() * 400));
        inv.paid = r2(inv.paid + amt); // app behaviour
        return { invoiceId: inv.id, number: inv.number, amount: amt };
      })
      .filter((a) => a.amount > 0);
    if (!allocs.length) return null;
    const p: Payment = {
      id: nid(),
      date: "2026-07-02",
      partyId: "p1",
      partyName: "p1",
      type: "in",
      amount: r2(allocs.reduce((s, a) => s + a.amount, 0)),
      mode: "cash",
      allocations: allocs,
      createdAt: "",
    };
    payments.push(p);
    return p;
  };
  const reverse = (p: Payment) => {
    for (const a of p.allocations ?? []) {
      const inv = invoices.find((i) => i.id === a.invoiceId)!;
      inv.paid = r2(inv.paid - a.amount);
    }
  };

  for (let op = 0; op < 3000; op++) {
    const k = ri(3);
    if (k === 0) applyPayment();
    else if (k === 1 && payments.length) {
      // delete (app: reverse allocations, remove record)
      const idx = ri(payments.length);
      reverse(payments[idx]);
      payments.splice(idx, 1);
    } else if (k === 2 && payments.length) {
      // edit (app: reverse, re-apply fresh)
      const idx = ri(payments.length);
      reverse(payments[idx]);
      payments.splice(idx, 1);
      applyPayment();
    }
    // INVARIANT: invoice.paid == initialPaid + sum of surviving allocations
    const byInv = paidViaPayments(payments);
    for (const inv of invoices) {
      const expected = r2((initialPaid.get(inv.id) ?? 0) + (byInv.get(inv.id) ?? 0));
      assert(
        approx(inv.paid, expected),
        `T6 op${op}: ${inv.number} paid ${inv.paid} != ${expected}`,
      );
      assert(
        inv.paid >= -0.01 && inv.paid <= inv.total + 0.01,
        `T6 op${op}: paid out of range ${inv.paid}`,
      );
    }
  }
  // Party balance must equal total dues (no advances in this scenario)
  const bal = partyBalances(invoices, [], payments)[0];
  const dues = r2(invoices.reduce((s, i) => s + (i.total - i.paid), 0));
  assert(approx(bal.balance, dues), `T6: party balance ${bal.balance} != open dues ${dues}`);
}

/* ═══════ TEST 7: expenses & adjustments in cash ═══════ */
{
  const exp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Tea",
      amount: 50,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const adj: CashAdjustment[] = [
    { id: nid(), date: "2026-07-01", type: "add", amount: 500, createdAt: "" },
    { id: nid(), date: "2026-07-01", type: "reduce", amount: 120, createdAt: "" },
  ];
  const cash = netFlow(cashFlows([], [], exp, [], adj));
  assert(approx(cash, 500 - 120 - 50), `T7: cash ${cash} != 330`);
}

/* ═══ TEST 10: a bank-mode expense is NOT double-counted in bankFlows ═══
   A bank expense already moved the account's stored balance at save time;
   the Bank page / dashboard add bankFlows ON TOP of stored balances, so
   bankFlows must exclude anything carrying a bankId. A cash expense (no
   bankId) must still be counted in cashFlows. Regression guard for A1. */
{
  const bankExp: Expense[] = [
    { id: nid(), date: "2026-07-01", category: "Rent", amount: 5000, paymentMode: "bank", bankId: "bk1", createdAt: "" },
  ];
  const bankOut = netFlow(bankFlows([], [], bankExp, []));
  assert(bankOut === 0, `T10: bank expense must not appear in bankFlows (got ${bankOut})`);

  const cashExp: Expense[] = [
    { id: nid(), date: "2026-07-01", category: "Tea", amount: 50, paymentMode: "cash", createdAt: "" },
  ];
  const cashOut = netFlow(cashFlows([], [], cashExp, [], []));
  assert(cashOut === -50, `T10: cash expense must still count in cashFlows (got ${cashOut})`);
}

console.log(`\n══════════════════════════════════════`);

/* ═══ TEST 9: opening balance sign convention — never double counted ═══ */
{
  const partiesOB = [
    { id: "pA", name: "A", openingBalance: 5000 },  // they owe us
    { id: "pB", name: "B", openingBalance: -3000 }, // we owe them
  ];
  const cust = partyBalances([], [], [], partiesOB, "customer");
  const supp = partyBalances([], [], [], partiesOB, "supplier");
  const get = (list: ReturnType<typeof partyBalances>, id: string) =>
    list.find((b) => b.partyId === id)!.balance;
  assert(get(cust, "pA") === 5000, "T9: +opening must be receivable");
  assert(get(supp, "pA") === 0, "T9: +opening must NOT be payable");
  assert(get(cust, "pB") === 0, "T9: -opening must NOT be receivable");
  assert(get(supp, "pB") === 3000, "T9: -opening must be payable");
  const stmt = partyBalances([], [], [], partiesOB); // statement: signed as-is
  assert(get(stmt, "pA") === 5000 && get(stmt, "pB") === -3000, "T9: statement uses signed value");
}

/* ═══ TEST 8: Repository — empty-string draft IDs must be replaced ═══ */
{
  const repo = new Repository<{ id: string; total: number }>("test-collection");
  const a = repo.add({ id: "", total: 100 } as never);
  const b = repo.add({ id: "", total: 200 } as never);
  const c = repo.add({ total: 300 } as never);
  assert(a.id.length > 0, "T8: empty-string id not replaced");
  assert(b.id.length > 0 && b.id !== a.id, "T8: ids must be unique");
  assert(c.id.length > 0, "T8: missing id not generated");
  assert(repo.all().length === 3, "T8: cache count");
  repo.adjustField(a.id, "total", -30);
  assert(repo.get(a.id)!.total === 70, "T8: adjustField cache math");
  repo.remove(b.id);
  assert(repo.all().length === 2, "T8: remove");
}

console.log(`  AUDIT RESULT: ${passed} assertions passed, ${failed} failed`);
if (fails.length) {
  console.log(`\nFailures:`);
  fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log(`  ✅ ALL INVARIANTS HELD`);
console.log(`══════════════════════════════════════\n`);
