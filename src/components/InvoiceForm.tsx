import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import {
  PartyRepo,
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  CompanyRepo,
  nextInvoiceNumber,
  SaleReturnRepo,
  PurchaseReturnRepo,
  PaymentRepo,
  BankRepo,
  ReferralLedgerRepo,
} from "@/repositories";
import { partyBalances } from "@/lib/ledger";
import { computeReferralCommission } from "@/lib/referral";
import type { Invoice, LineItem, Party, Item, PaymentMode, BankAccount } from "@/types";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import { toast } from "sonner";
import {
  Trash2,
  UserPlus,
  Save,
  X,
  Printer,
  FileText,
  Receipt,
  Pencil,
  Check,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { PrintableInvoice } from "@/components/PrintableInvoice";
import { itemCodesByLine } from "@/lib/itemCodes";
import { NumInput, NumField } from "@/components/NumInput";
import { ModePills } from "@/components/ModePills";
import { QuickAddPartyDialog, type QuickAddPartyDetails } from "@/components/QuickAddPartyDialog";
import { genId, newBatch, commitBatch } from "@/repositories/base";
import { stockShortfalls } from "@/lib/stock";
import { useRepoData } from "@/hooks/useRepoData";

interface Props {
  mode: "sale" | "purchase";
  existing?: Invoice | null;
}

export function InvoiceForm({ mode, existing }: Props) {
  useRepoData();
  const navigate = useNavigate();
  const company = CompanyRepo.get();
  const isSale = mode === "sale";
  const repo = isSale ? SalesRepo : PurchaseRepo;
  // Archived parties are hidden from the picker (no NEW transactions for
  // them) — but the full `allParties` list is still used for save-time dedup
  // below, so typing an archived party's exact name still reuses (and
  // auto-restores) it instead of creating a duplicate.
  const partyFilter = (p: Party) => !p.archived;

  const [inv, setInv] = useState<Invoice>(
    () =>
      existing ?? {
        id: "",
        number: nextInvoiceNumber(
          isSale ? company.invoicePrefix : company.purchasePrefix,
          repo.all(),
        ),
        date: today(),
        partyId: "",
        partyName: "",
        partyPhone: "",
        // New bills start with GST off — the cashier turns it on per-bill
        // when actually needed, instead of every bill defaulting to a tax invoice.
        gstEnabled: false,
        lineItems: [],
        subtotal: 0,
        discount: 0,
        shippingCharge: 0,
        taxAmount: 0,
        total: 0,
        paid: 0,
        paymentMode: "credit",
        createdAt: "",
        notes: "",
      },
  );

  const gstOn = inv.gstEnabled !== false;

  const [allParties, setAllParties] = useState(() => PartyRepo.all());
  const parties = useMemo(() => allParties.filter(partyFilter), [allParties]);
  const [items, setItems] = useState(() => ItemRepo.all());
  const [banks] = useState<BankAccount[]>(() => BankRepo.all());
  // Vyapar-style entry: starts with 2 blank rows below the filled items,
  // each a self-contained search-and-add row. Row ids (not indexes) so the
  // untouched row keeps its own typed-but-not-submitted text when the other
  // one is completed and shifts up.
  const ITEM_ENTRY_ROWS = 2;
  const [pendingRowIds, setPendingRowIds] = useState<string[]>(() =>
    Array.from({ length: ITEM_ENTRY_ROWS }, () => genId()),
  );
  const pendingInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Called when a pending row's item is added — that row is retired. A
  // fresh blank one is appended ONLY if that was the last blank row left
  // (buffer would hit 0), not after every single completion — so filling
  // the first of the 2 starting rows leaves the other one as-is (no new row
  // yet), and only filling that last one too triggers a fresh replacement.
  const completePendingRow = (rowId: string) => {
    setPendingRowIds((prev) => {
      const remaining = prev.filter((id) => id !== rowId);
      return remaining.length === 0 ? [genId()] : remaining;
    });
  };
  // After an item is picked, focus goes to THAT row's Qty field (id
  // "qty-<lineId>") so the amount can be typed immediately — not to the next
  // blank search row. Pressing Enter in Qty is what advances to the next row.
  const focusQtyId = useRef<string | null>(null);
  useEffect(() => {
    if (focusQtyId.current) {
      const el = document.getElementById(`qty-${focusQtyId.current}`) as HTMLInputElement | null;
      el?.focus();
      el?.select();
      focusQtyId.current = null;
    }
  }, [inv.lineItems]);
  const focusFirstPendingRow = () => {
    pendingInputRefs.current[pendingRowIds[0]]?.focus();
  };
  // A party or item typed at the counter that doesn't exist yet is no longer
  // silently created with blank/zero defaults — these open a quick-add
  // dialog asking for the real details (phone/opening balance, or
  // price/GST) before it's actually created.
  const [quickAddParty, setQuickAddParty] = useState<{
    name: string;
    phone: string;
    paid: number;
    andPrint: boolean;
  } | null>(null);
  const [quickAddItem, setQuickAddItem] = useState<{ name: string; rowId: string } | null>(null);
  const partyRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const [partyQ, setPartyQ] = useState(existing?.partyName ?? "");
  const [phoneQ, setPhoneQ] = useState(existing?.partyPhone ?? "");
  const [partyOpen, setPartyOpen] = useState(false);
  const [partyIdx, setPartyIdx] = useState(0);
  const [numberEditing, setNumberEditing] = useState(false);
  const numberRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const bankSelectRef = useRef<HTMLInputElement>(null);
  const prevPaymentMode = useRef(inv.paymentMode);
  useEffect(() => {
    // Only jump focus on an actual switch to "bank" — not on mount, or an
    // already-bank invoice would steal focus away from wherever the cashier
    // is when opening it for edit.
    if (inv.paymentMode === "bank" && prevPaymentMode.current !== "bank") {
      bankSelectRef.current?.focus();
    }
    prevPaymentMode.current = inv.paymentMode;
  }, [inv.paymentMode]);

  // Search-as-you-type for Bank Account — same combobox pattern as the
  // party picker above, since a shop can have many accounts and a plain
  // dropdown makes them scroll-hunt for one.
  const [bankQ, setBankQ] = useState("");
  const [bankOpen, setBankOpen] = useState(false);
  const [bankIdx, setBankIdx] = useState(0);
  useEffect(() => {
    setBankQ(banks.find((b) => b.id === inv.bankId)?.name ?? "");
  }, [inv.bankId, banks]);
  const bankSuggests = useMemo(() => {
    const q = bankQ.trim().toLowerCase();
    if (!q) return banks;
    return banks.filter(
      (b) => b.name.toLowerCase().includes(q) || (b.accountNumber ?? "").toLowerCase().includes(q),
    );
  }, [banks, bankQ]);
  const selectBank = (b: BankAccount) => {
    setInv({ ...inv, bankId: b.id });
    setBankQ(b.name);
    setBankOpen(false);
  };

  // Live outstanding balance of the selected party (credit decision at the counter)
  const partyBalance = useMemo(() => {
    if (!inv.partyId) return null;
    const list = partyBalances(
      isSale ? SalesRepo.all() : PurchaseRepo.all(),
      isSale ? SaleReturnRepo.all() : PurchaseReturnRepo.all(),
      PaymentRepo.all().filter((p) => p.type === (isSale ? "in" : "out")),
      allParties.filter((p) => (isSale ? p.type !== "supplier" : p.type !== "customer")),
      isSale ? "customer" : "supplier",
    );
    return list.find((b) => b.partyId === inv.partyId)?.balance ?? 0;
  }, [inv.partyId, isSale]);

  // Live referral-commission preview — only meaningful for an already-picked
  // party (a brand-new party's referrer is chosen inside the quick-add
  // dialog, after which the bill saves straight away, so there's no earlier
  // moment to preview it for that path). Internal-only figure, purely
  // informational — never folded into inv.total.
  const referralPreview = useMemo(() => {
    if (!isSale || !inv.partyId) return null;
    const referrerId = PartyRepo.get(inv.partyId)?.referredBy;
    if (!referrerId || referrerId === inv.partyId) return null;
    const referrer = PartyRepo.get(referrerId);
    if (!referrer || referrer.archived) return null;
    // Still surfaced when the program is off — silently hiding this would
    // look like the referral link itself is broken rather than a Settings
    // toggle waiting to be flipped on.
    if (!company.referralEnabled) return { referrerName: referrer.name, commission: 0, disabled: true };
    const commission = computeReferralCommission(
      inv.total,
      company.referralPercent ?? 10,
      company.referralMaxPerBill ?? 500,
    );
    return { referrerName: referrer.name, commission, disabled: false };
  }, [isSale, company.referralEnabled, company.referralPercent, company.referralMaxPerBill, inv.partyId, inv.total]);

  // How much of THIS party's wallet this bill can draw on. Redemption stays
  // spendable even if the program is currently off (that only gates NEW
  // accrual) — it's their own already-earned balance. Adds back what this
  // exact bill previously redeemed (on edit) since the party's live balance
  // already reflects that past deduction — otherwise re-opening an edited
  // bill would show a shrinking "available" figure across repeated saves.
  const cashbackAvailable = useMemo(() => {
    if (!isSale || !inv.partyId) return 0;
    const liveBalance = PartyRepo.get(inv.partyId)?.referralWalletBalance ?? 0;
    const ownPriorRedemption = existing?.partyId === inv.partyId ? (existing?.redeemedCashback ?? 0) : 0;
    return r2(liveBalance + ownPriorRedemption);
  }, [isSale, inv.partyId, existing]);

  const partySuggests = useMemo(() => {
    const q = partyQ.trim().toLowerCase();
    const pq = phoneQ.trim();
    // Empty query — browse the full party list (like a combobox), instead
    // of showing nothing until the user starts typing.
    if (!q && !pq) return parties.slice(0, 8);
    return parties
      .filter(
        (p) => (q && p.name.toLowerCase().includes(q)) || (pq && (p.phone ?? "").includes(pq)),
      )
      .slice(0, 8);
  }, [partyQ, phoneQ, parties]);

  useEffect(() => {
    partyRef.current?.focus();
  }, []);

  const r2 = (n: number) => Math.round(n * 100) / 100;

  const roundEnabled = company.enableRoundOff !== false;

  const recalc = (
    lines: LineItem[],
    discount = inv.discount,
    gst = gstOn,
    shipping = inv.shippingCharge ?? 0,
    redeemedCashback = inv.redeemedCashback ?? 0,
  ) => {
    const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.price, 0));
    const afterLineDisc = r2(
      lines.reduce((s, l) => s + r2(l.qty * l.price * (1 - l.discountPct / 100)), 0),
    );
    const taxAmount = gst
      ? r2(
          lines.reduce(
            (s, l) => s + r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * (l.gstRate / 100)),
            0,
          ),
        )
      : 0;
    const rawTotal = Math.max(0, r2(afterLineDisc + taxAmount - discount - redeemedCashback + shipping));
    // Indian billing convention: round to the nearest whole rupee
    const total = roundEnabled ? Math.round(rawTotal) : rawTotal;
    const roundOff = r2(total - rawTotal);
    return { subtotal, taxAmount, total, roundOff };
  };

  const selectParty = (p: Party) => {
    setInv({ ...inv, partyId: p.id, partyName: p.name, partyPhone: p.phone ?? "" });
    setPartyQ(p.name);
    setPhoneQ(p.phone ?? "");
    setPartyOpen(false);
    setTimeout(() => document.getElementById("inv-date")?.focus(), 30);
  };

  const clearParty = () => {
    setInv({ ...inv, partyId: "", partyName: "", partyPhone: "" });
    setPartyQ("");
    setPhoneQ("");
    setTimeout(() => partyRef.current?.focus(), 30);
  };

  // Every past bill where this party bought/sold each item, most recent
  // first — many shops negotiate a standing rate per customer/item that
  // doesn't match the catalog price, so seeing (and re-using) the last few
  // prices charged beats re-typing it from memory every time. Indexed once
  // per selected party: the render path asks for this per line row on every
  // keystroke, and a fresh scan of every invoice each time made typing lag
  // once the shop had a few thousand bills.
  const partyHistoryIndex = useMemo(() => {
    const map = new Map<string, { date: string; created: string; qty: number; price: number }[]>();
    if (!inv.partyId) return map;
    for (const doc of repo.all()) {
      if (doc.partyId !== inv.partyId) continue;
      for (const l of doc.lineItems) {
        let rows = map.get(l.itemId);
        if (!rows) map.set(l.itemId, (rows = []));
        rows.push({ date: doc.date, created: doc.createdAt || "", qty: l.qty, price: l.price });
      }
    }
    for (const rows of map.values())
      rows.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv.partyId, repo]);

  const partyItemHistory = (itemId: string): { date: string; qty: number; price: number }[] =>
    (partyHistoryIndex.get(itemId) ?? [])
      .slice(0, 5)
      .map(({ date, qty, price }) => ({ date, qty, price }));

  const lastPartyPrice = (itemId: string): number | undefined =>
    partyHistoryIndex.get(itemId)?.[0]?.price;

  // Returns the id of the line that was added/updated, so the caller can move
  // focus straight to that row's Qty field for fast entry.
  const addLineItem = (it: Item): string => {
    // Repeat items cannot be added twice — increase quantity of the existing line instead
    const existingLine = inv.lineItems.find((l) => l.itemId === it.id);
    if (existingLine) {
      updateLine(existingLine.id, { qty: existingLine.qty + 1 });
      toast.info(`${it.name} — quantity increased to ${existingLine.qty + 1}`);
      return existingLine.id;
    }
    const historicalPrice = lastPartyPrice(it.id);
    const line: LineItem = {
      id: genId(),
      itemId: it.id,
      name: it.name,
      qty: 1,
      unit: it.unit,
      price: historicalPrice ?? (isSale ? it.salePrice || it.purchasePrice : it.purchasePrice),
      discountPct: 0,
      gstRate: it.gstRate,
      amount: 0,
      costPrice: it.purchasePrice,
    };
    const gstMult = gstOn ? 1 + line.gstRate / 100 : 1;
    line.amount = r2(r2(line.qty * line.price * (1 - line.discountPct / 100)) * gstMult);
    const lines = [...inv.lineItems, line];
    setInv({ ...inv, lineItems: lines, ...recalc(lines) });
    return line.id;
  };

  // Called from the quick-add-item dialog once the cashier has actually
  // entered price/GST/unit — a name typed at the counter that doesn't match
  // any known item is never auto-created with blank/zero defaults anymore.
  const confirmQuickAddItem = (details: {
    name: string;
    sku: string;
    unit: string;
    gstRate: number;
    salePrice: number;
    purchasePrice: number;
  }) => {
    if (!quickAddItem) return;
    const rowId = quickAddItem.rowId;
    setQuickAddItem(null);
    const existingMatch = items.find(
      (i) => i.name.trim().toLowerCase() === details.name.trim().toLowerCase(),
    );
    if (existingMatch) {
      focusQtyId.current = addLineItem(existingMatch);
      completePendingRow(rowId);
      return;
    }
    const newItem = ItemRepo.add({
      name: details.name.trim(),
      sku: details.sku.trim() || undefined,
      unit: details.unit.trim() || "pcs",
      gstRate: Math.max(0, details.gstRate),
      purchasePrice: Math.max(0, details.purchasePrice),
      salePrice: Math.max(0, details.salePrice),
      stock: 0,
      openingStock: 0,
    }) as Item;
    setItems(ItemRepo.all());
    focusQtyId.current = addLineItem(newItem);
    completePendingRow(rowId);
    toast.success(`New item added: ${newItem.name}`);
  };

  // Landed per-unit cost for an international purchase: convert the foreign
  // price to INR, then add the flat per-piece freight/customs cost — e.g.
  // 44 (foreign) * 14 (rate) + 10 (carry) = ₹636/pc.
  const landedPrice = (foreignPrice: number) =>
    r2(foreignPrice * (inv.exchangeRate ?? 0) + (inv.carryCostPerUnit ?? 0));

  const updateLine = (id: string, patch: Partial<LineItem>) => {
    const lines = inv.lineItems.map((l) => {
      if (l.id !== id) return l;
      const nl = { ...l, ...patch };
      // Clamp so a mistyped discount (e.g. 500 instead of 50) or a negative
      // GST rate can never flip the line amount negative.
      nl.discountPct = Math.min(100, Math.max(0, nl.discountPct));
      nl.gstRate = Math.max(0, nl.gstRate);
      // Auto-fill the INR price whenever the foreign price changes — still
      // a normal editable field afterward, so a cashier can override it.
      if (inv.isInternational && "foreignPrice" in patch && nl.foreignPrice != null) {
        nl.price = landedPrice(nl.foreignPrice);
      }
      const gstMult = gstOn ? 1 + nl.gstRate / 100 : 1;
      nl.amount = r2(r2(nl.qty * nl.price * (1 - nl.discountPct / 100)) * gstMult);
      return nl;
    });
    setInv({ ...inv, lineItems: lines, ...recalc(lines) });
  };

  // Changing the exchange rate or per-piece carry cost after items are
  // already on the bill should re-price every line that has a foreign price
  // set — otherwise "auto-fill" would only ever apply retroactively to the
  // next item typed, leaving already-added rows silently stale.
  const updateInternational = (patch: {
    isInternational?: boolean;
    exchangeRate?: number;
    carryCostPerUnit?: number;
  }) => {
    const merged = { ...inv, ...patch };
    const rate = merged.exchangeRate ?? 0;
    const carry = merged.carryCostPerUnit ?? 0;
    const lines = inv.lineItems.map((l) => {
      if (l.foreignPrice == null) return l;
      const price = r2(l.foreignPrice * rate + carry);
      const gstMult = gstOn ? 1 + l.gstRate / 100 : 1;
      const amount = r2(r2(l.qty * price * (1 - l.discountPct / 100)) * gstMult);
      return { ...l, price, amount };
    });
    setInv({ ...merged, lineItems: lines, ...recalc(lines) });
  };

  const removeLine = (id: string) => {
    const lines = inv.lineItems.filter((l) => l.id !== id);
    setInv({ ...inv, lineItems: lines, ...recalc(lines) });
  };

  // Swaps the item on an already-added row (clicked from the item-name cell)
  // instead of forcing a delete + re-add. Qty/discount are kept as typed;
  // price/unit/GST reset to the newly picked item (party's historical price
  // if there is one), same defaulting as a fresh addLineItem(). Returns the
  // id of the row that ends up holding the item, so the caller can move
  // focus straight to its Qty field.
  const changeLineItem = (lineId: string, it: Item): string => {
    const dup = inv.lineItems.find((l) => l.itemId === it.id && l.id !== lineId);
    if (dup) {
      const removed = inv.lineItems.find((l) => l.id === lineId);
      const mergedQty = dup.qty + (removed?.qty ?? 0);
      const gstMult = gstOn ? 1 + dup.gstRate / 100 : 1;
      const lines = inv.lineItems
        .filter((l) => l.id !== lineId)
        .map((l) =>
          l.id === dup.id
            ? {
                ...l,
                qty: mergedQty,
                amount: r2(r2(mergedQty * l.price * (1 - l.discountPct / 100)) * gstMult),
              }
            : l,
        );
      setInv({ ...inv, lineItems: lines, ...recalc(lines) });
      toast.info(`${it.name} — merged into existing line, quantity increased to ${mergedQty}`);
      return dup.id;
    }
    const historicalPrice = lastPartyPrice(it.id);
    updateLine(lineId, {
      itemId: it.id,
      name: it.name,
      unit: it.unit,
      gstRate: it.gstRate,
      price: historicalPrice ?? (isSale ? it.salePrice || it.purchasePrice : it.purchasePrice),
      costPrice: it.purchasePrice,
      // The old item's foreign price must not survive the swap — a later
      // exchange-rate change re-prices every line that still has one, which
      // would overwrite the new item's price with the OLD item's landed cost.
      foreignPrice: undefined,
    });
    return lineId;
  };

  const setDiscount = (d: number) => setInv({ ...inv, discount: d, ...recalc(inv.lineItems, d) });

  const setShippingCharge = (s: number) =>
    setInv({
      ...inv,
      shippingCharge: s,
      ...recalc(inv.lineItems, inv.discount, gstOn, s),
    });

  // Mirrors setDiscount's own leniency — only floors at zero here, same as
  // Extra Discount tolerates a value bigger than the subtotal (recalc's own
  // Math.max(0, …) just floors the total). The hard caps that actually
  // matter (can't exceed the wallet, can't exceed the bill) are enforced
  // once, at save time, in save() — this field debits a real balance unlike
  // Extra Discount, so those checks can't be skipped the way a keystroke cap
  // could be.
  const setRedeemedCashback = (v: number) => {
    const redeemedCashback = Math.max(0, v);
    setInv({
      ...inv,
      redeemedCashback,
      ...recalc(inv.lineItems, inv.discount, gstOn, inv.shippingCharge ?? 0, redeemedCashback),
    });
  };

  const toggleGst = () => {
    const newGst = !gstOn;
    const lines = inv.lineItems.map((l) => {
      const gstMult = newGst ? 1 + l.gstRate / 100 : 1;
      return { ...l, amount: r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * gstMult) };
    });
    setInv({
      ...inv,
      gstEnabled: newGst,
      lineItems: lines,
      ...recalc(lines, inv.discount, newGst),
    });
  };

  // Runs once the party is fully resolved — either an existing match, or a
  // brand-new one whose details were just collected via the quick-add
  // dialog (never silently defaulted). Everything here is the actual write:
  // the party (if new), the invoice, its stock/bank effects, and any
  // Payment re-allocation land together in one atomic batch.
  const finalizeSave = (
    party: { id: string; name: string } | { create: Party },
    phone: string,
    paid: number,
    andPrint: boolean,
  ) => {
    // Changing the party on a bill that already has payments linked to it
    // would leave that received money attributed to the OLD party — the
    // dashboard (which reads invoice.paid) and the party statement (which
    // reads the payment's own partyId) would then disagree, and the cash
    // would show under the wrong name. Block it: the payment must be removed
    // (or the bill left on its original party) first.
    if (existing?.id) {
      const newPartyId = "create" in party ? party.create.id : party.id;
      if (newPartyId !== existing.partyId) {
        const linkedPayment = PaymentRepo.all().some(
          (p) =>
            p.allocations?.some((a) => a.invoiceId === existing.id) ||
            (!p.allocations?.length &&
              (p.ref ?? "")
                .split(",")
                .map((s) => s.trim())
                .includes(existing.number.trim())),
        );
        if (linkedPayment) {
          toast.error(
            "This bill has payments linked to its current party. Delete those payments (or keep the same party) before changing it — otherwise the received money would stay under the old party.",
          );
          return;
        }
      }
    }

    savingRef.current = true;
    setSaving(true);

    const batch = newBatch();

    let partyId: string;
    let partyName: string;
    if ("create" in party) {
      PartyRepo.addBatched(batch, party.create);
      setAllParties(PartyRepo.all());
      partyId = party.create.id;
      partyName = party.create.name;
      toast.success(`New party added: ${partyName}`);
    } else {
      partyId = party.id;
      partyName = party.name;
      // Reusing an archived party for a NEW bill means they're active again —
      // restore them in the same batch so they reappear in pickers and the
      // active list (Zoho/QuickBooks "reactivate on use"). Only on a new bill:
      // merely editing an OLD bill for an already-archived party must not
      // silently un-archive it.
      if (!existing?.id && PartyRepo.get(partyId)?.archived) {
        PartyRepo.updateBatched(batch, partyId, { archived: false });
        setAllParties(PartyRepo.all());
      }
    }

    // Pinned down up front (not left to addBatched's own genId() fallback)
    // so the referral ledger entries below can reference this invoice's id
    // before it's actually written.
    const invoiceId = existing?.id || genId();

    const finalInv: Invoice = {
      ...inv,
      id: invoiceId,
      number: inv.number.trim(),
      paid,
      partyId,
      partyName,
      partyPhone: phone,
      bankId: inv.paymentMode === "bank" ? inv.bankId : undefined,
      bankPaidAmount: inv.paymentMode === "bank" ? paid : undefined,
    };

    // This invoice's own paid-at-billing amount can move money on a specific
    // bank account. Reverse whatever it PREVIOUSLY moved (tracked via the
    // bankPaidAmount snapshot, not `existing.paid` — paid can also grow
    // later via unrelated Payment-page allocations that never touched this
    // bank account) before applying what it moves now, in the same batch as
    // everything else in this save.
    if (existing?.paymentMode === "bank" && existing.bankId && (existing.bankPaidAmount ?? 0) > 0) {
      BankRepo.adjustFieldBatched(
        batch,
        existing.bankId,
        "balance",
        isSale ? -existing.bankPaidAmount! : existing.bankPaidAmount!,
      );
    }
    if (finalInv.paymentMode === "bank" && finalInv.bankId && (finalInv.bankPaidAmount ?? 0) > 0) {
      BankRepo.adjustFieldBatched(
        batch,
        finalInv.bankId,
        "balance",
        isSale ? finalInv.bankPaidAmount! : -finalInv.bankPaidAmount!,
      );
    }

    // If editing dropped the settled amount (bill total reduced, or paid
    // lowered manually), Payment allocations tied to this invoice can now
    // exceed what's actually owed. Trim them so the freed money surfaces as
    // an advance instead of silently vanishing from ledger reports.
    // IMPORTANT: this runs AFTER every validation early-return (cache writes
    // land immediately), and the excess is recomputed from the LIVE
    // allocations — never from existing.paid — so a failed attempt or a
    // retry can never trim the same money twice.
    if (existing?.id) {
      const liveAllocated = r2(
        PaymentRepo.all().reduce(
          (s, p) =>
            s +
            (p.allocations ?? [])
              .filter((a) => a.invoiceId === existing.id)
              .reduce((x, a) => x + a.amount, 0),
          0,
        ),
      );
      let excess = r2(liveAllocated - paid);
      for (const p of PaymentRepo.all()) {
        if (excess <= 0) break;
        const alloc = p.allocations?.find((a) => a.invoiceId === existing.id);
        if (!alloc) continue;
        const reduceBy = Math.min(alloc.amount, excess);
        const remaining = p
          .allocations!.map((a) =>
            a.invoiceId === existing.id ? { ...a, amount: r2(a.amount - reduceBy) } : a,
          )
          .filter((a) => a.amount > 0);
        PaymentRepo.updateBatched(batch, p.id, {
          allocations: remaining.length ? remaining : undefined,
        });
        excess = r2(excess - reduceBy);
      }
    }

    if (existing?.id) {
      // Reverse original stock before applying new quantities (atomic increments)
      const origDelta = isSale ? 1 : -1;
      for (const l of existing.lineItems) {
        const it = ItemRepo.get(l.itemId);
        if (it) ItemRepo.adjustFieldBatched(batch, it.id, "stock", origDelta * l.qty);
      }
    }

    const stockDelta = isSale ? -1 : 1;
    for (const l of finalInv.lineItems) {
      const it = ItemRepo.get(l.itemId);
      if (!it) continue;
      const extra: Partial<Item> = {};
      if (l.price > 0) {
        // Sale price: only fill in when empty (bills often have per-customer discounts)
        if (isSale && !it.salePrice) extra.salePrice = l.price;
        // Purchase price: always track the LATEST cost so profit stays accurate
        if (!isSale && it.purchasePrice !== l.price) extra.purchasePrice = l.price;
      }
      ItemRepo.adjustFieldBatched(batch, it.id, "stock", stockDelta * l.qty, extra);
    }

    // Warn (non-blocking) when a sale pushes stock below zero — shop can still bill
    if (isSale) {
      const negative = finalInv.lineItems
        .map((l) => ItemRepo.get(l.itemId))
        .filter((it): it is Item => !!it && it.stock < 0);
      if (negative.length) {
        toast.warning(
          `Stock below zero: ${negative.map((i) => i.name).join(", ")} — add purchase entry`,
        );
      }
      // Credit limit alert for credit sales
      const partyRecord = PartyRepo.get(partyId);
      if (partyRecord?.creditLimit && partyBalance !== null) {
        const newBalance =
          partyBalance +
          (finalInv.total - finalInv.paid) -
          (existing ? Math.max(0, (existing.total ?? 0) - (existing.paid ?? 0)) : 0);
        if (newBalance > partyRecord.creditLimit) {
          toast.warning(
            `${partyName} crossed credit limit ${fmtMoney(partyRecord.creditLimit)} — balance now ${fmtMoney(newBalance)}`,
          );
        }
      }
    }

    // ── Cashback redemption (Sales only) ───────────────────────────
    // Already validated in save() against both the live wallet balance and
    // the bill's own value — this just applies it, atomically with
    // everything else in this batch. Reversal-then-reapply, same shape as
    // the referral commission block right below.
    if (isSale) {
      if (existing?.redeemedCashback) {
        PartyRepo.adjustFieldBatched(
          batch,
          existing.partyId,
          "referralWalletBalance",
          existing.redeemedCashback,
        );
      }
      if (finalInv.redeemedCashback) {
        PartyRepo.adjustFieldBatched(batch, partyId, "referralWalletBalance", -finalInv.redeemedCashback);
        ReferralLedgerRepo.addBatched(batch, {
          partyId,
          role: "redemption",
          invoiceId,
          invoiceNumber: finalInv.number,
          counterpartyId: partyId,
          counterpartyName: partyName,
          billAmount: finalInv.total,
          commission: -finalInv.redeemedCashback,
        });
      }
    }

    // ── Referral commission (Sales only) ──────────────────────────
    // Both the party on this bill AND whoever referred them earn a cut —
    // credited straight to each party's referral wallet, atomically with
    // everything else in this batch, so a bill save either fully commits
    // (invoice + stock + bank + referral wallets) or nothing does.
    if (isSale && company.referralEnabled) {
      // Reverse whatever THIS invoice last granted before recomputing what
      // it should grant now — same reversal-then-reapply shape as the stock
      // adjustment above, keyed off the invoice's own snapshot rather than
      // re-summing the ledger, so editing the total (or changing the party)
      // never leaves a stale credit sitting in either wallet.
      if (existing?.referralCommission) {
        const prevReferrerId = PartyRepo.get(existing.partyId)?.referredBy;
        PartyRepo.adjustFieldBatched(
          batch,
          existing.partyId,
          "referralWalletBalance",
          -existing.referralCommission,
        );
        if (prevReferrerId) {
          PartyRepo.adjustFieldBatched(
            batch,
            prevReferrerId,
            "referralWalletBalance",
            -existing.referralCommission,
          );
        }
      }

      const referrerId = PartyRepo.get(partyId)?.referredBy;
      const referrer =
        referrerId && referrerId !== partyId ? PartyRepo.get(referrerId) : undefined;
      if (referrer && !referrer.archived) {
        const commission = computeReferralCommission(
          finalInv.total,
          company.referralPercent ?? 10,
          company.referralMaxPerBill ?? 500,
        );
        finalInv.referralCommission = commission;
        PartyRepo.adjustFieldBatched(batch, partyId, "referralWalletBalance", commission);
        PartyRepo.adjustFieldBatched(batch, referrer.id, "referralWalletBalance", commission);
        ReferralLedgerRepo.addBatched(batch, {
          partyId,
          role: "referee",
          invoiceId,
          invoiceNumber: finalInv.number,
          counterpartyId: referrer.id,
          counterpartyName: referrer.name,
          billAmount: finalInv.total,
          commission,
        });
        ReferralLedgerRepo.addBatched(batch, {
          partyId: referrer.id,
          role: "referrer",
          invoiceId,
          invoiceNumber: finalInv.number,
          counterpartyId: partyId,
          counterpartyName: partyName,
          billAmount: finalInv.total,
          commission,
        });
      } else {
        finalInv.referralCommission = undefined;
      }
    }

    // If the bill NUMBER was changed on edit, the records that reference it by
    // that string (returns via originalRef, and payments via their allocation
    // display number / legacy ref) would otherwise point at a number that no
    // longer exists — the return's over-return cap silently stops matching and
    // the linked-invoice display goes stale. Cascade the rename to them in the
    // same batch. (Payment MATH keys on invoiceId, so balances stay correct
    // regardless; this keeps the human-readable links right too.)
    if (existing?.id) {
      const oldNum = (existing.number ?? "").trim();
      const newNum = finalInv.number;
      if (oldNum && oldNum !== newNum) {
        const retRepo = isSale ? SaleReturnRepo : PurchaseReturnRepo;
        for (const ret of retRepo.all()) {
          if ((ret.originalRef ?? "").trim() === oldNum) {
            retRepo.updateBatched(batch, ret.id, { originalRef: newNum });
          }
        }
        for (const p of PaymentRepo.all()) {
          let changed = false;
          let allocations = p.allocations;
          if (p.allocations?.some((a) => a.invoiceId === existing.id)) {
            allocations = p.allocations.map((a) =>
              a.invoiceId === existing.id ? { ...a, number: newNum } : a,
            );
            changed = true;
          }
          let ref = p.ref;
          if (p.ref) {
            const tokens = p.ref.split(",").map((t) => t.trim());
            if (tokens.includes(oldNum)) {
              ref = tokens.map((t) => (t === oldNum ? newNum : t)).join(", ");
              changed = true;
            }
          }
          if (changed) PaymentRepo.updateBatched(batch, p.id, { allocations, ref });
        }
      }
    }

    let savedId: string;
    if (existing?.id) {
      repo.updateBatched(batch, existing.id, finalInv);
      savedId = existing.id;
      toast.success(`${isSale ? "Sale" : "Purchase"} ${finalInv.number} updated`);
    } else {
      savedId = (repo.addBatched(batch, finalInv as any) as Invoice).id;
      toast.success(`${isSale ? "Sale" : "Purchase"} ${finalInv.number} saved`);
    }
    commitBatch(batch, `save ${isSale ? "sale" : "purchase"}`);
    if (andPrint) {
      navigate({
        to: isSale ? "/sales/$id" : "/purchase/$id",
        params: { id: savedId },
        search: { print: 1 },
      });
    } else {
      navigate({ to: isSale ? "/sales" : "/purchase" });
    }
  };

  const save = (andPrint = false) => {
    if (savingRef.current) return; // double-click / Ctrl+S repeat protection

    // ── Validations ─────────────────────────────────────────────
    if (!inv.lineItems.length) {
      toast.error("Add at least one item");
      return;
    }
    const badLine = inv.lineItems.find((l) => !(l.qty > 0) || l.price < 0);
    if (badLine) {
      toast.error(`Check quantity/price for "${badLine.name}" — qty must be more than 0`);
      return;
    }
    if (isSale && company.allowNegativeStock === false) {
      const shortfalls = stockShortfalls(inv.lineItems, existing?.lineItems ?? []);
      if (shortfalls.length) {
        toast.error(`Not enough stock — ${shortfalls.join(", ")}`);
        return;
      }
    }
    // Editing an existing bill must never drop an item's quantity below what
    // has already been returned against this exact bill — otherwise returned
    // qty exceeds sold/purchased qty and both stock and the party balance get
    // over-credited (with no error to signal it). The return side has its own
    // over-return cap; this is the same guard from the bill side.
    if (existing?.id) {
      const returnRepo = isSale ? SaleReturnRepo : PurchaseReturnRepo;
      const returnedByItem = new Map<string, number>();
      for (const ret of returnRepo.all()) {
        if ((ret.originalRef ?? "").trim() !== existing.number.trim()) continue;
        for (const l of ret.lineItems) {
          returnedByItem.set(l.itemId, (returnedByItem.get(l.itemId) ?? 0) + l.qty);
        }
      }
      if (returnedByItem.size) {
        const newQtyByItem = new Map<string, number>();
        for (const l of inv.lineItems) {
          newQtyByItem.set(l.itemId, (newQtyByItem.get(l.itemId) ?? 0) + l.qty);
        }
        for (const [itemId, returned] of returnedByItem) {
          const nowQty = newQtyByItem.get(itemId) ?? 0;
          if (nowQty < returned - 0.0001) {
            const name =
              inv.lineItems.find((l) => l.itemId === itemId)?.name ??
              ItemRepo.get(itemId)?.name ??
              "this item";
            toast.error(
              `Can't reduce "${name}" to ${nowQty} — ${returned} already returned against ${existing.number}. Delete or adjust that return first.`,
            );
            return;
          }
        }
      }
    }
    const number = inv.number.trim();
    if (!number) {
      toast.error(`${isSale ? "Invoice" : "Bill"} number is required`);
      return;
    }
    const dupNo = repo.all().find((i) => i.number.trim() === number && i.id !== existing?.id);
    if (dupNo) {
      toast.error(`${isSale ? "Invoice" : "Bill"} number ${number} is already used — change it`);
      setNumberEditing(true);
      setTimeout(() => numberRef.current?.focus(), 50);
      return;
    }
    if (inv.paymentMode === "bank" && !inv.bankId) {
      toast.error("Select which bank account this goes to");
      return;
    }
    // Paid can never exceed the bill total
    let paid = inv.paid;
    if (paid > inv.total) {
      paid = inv.total;
      toast.info(`Paid amount adjusted to bill total ${fmtMoney(inv.total)}`);
    }

    // Redeemed cashback debits a real wallet balance — unlike Extra
    // Discount, it must be hard-blocked (not silently clamped) if it would
    // overdraw the wallet or redeem more value than the bill is actually
    // worth, or the wallet would end up wrong with no visible sign of it.
    if (isSale && (inv.redeemedCashback ?? 0) > 0) {
      if (inv.redeemedCashback! > cashbackAvailable + 0.01) {
        toast.error(
          `Only ${fmtMoney(cashbackAvailable)} cashback available for ${inv.partyName || "this party"} — reduce the redeemed amount.`,
        );
        return;
      }
      const billableBeforeRedemption = recalc(
        inv.lineItems,
        inv.discount,
        gstOn,
        inv.shippingCharge ?? 0,
        0,
      ).total;
      if (inv.redeemedCashback! > billableBeforeRedemption + 0.01) {
        toast.error(`Redeemed cashback can't exceed the bill amount (${fmtMoney(billableBeforeRedemption)})`);
        return;
      }
    }

    const partyId = inv.partyId;
    const partyName = inv.partyName || partyQ.trim();
    const phone = phoneQ.trim();

    if (partyId) {
      finalizeSave({ id: partyId, name: partyName }, phone, paid, andPrint);
      return;
    }
    if (!partyName && !phone) {
      toast.error("Enter customer name or phone");
      partyRef.current?.focus();
      return;
    }
    // Try match by phone first (unique), then by name
    const byPhone = phone ? allParties.find((p) => (p.phone ?? "").trim() === phone) : null;
    const byName = partyName
      ? allParties.find((p) => p.name.toLowerCase() === partyName.toLowerCase())
      : null;
    const existingParty = byPhone ?? byName;
    if (existingParty) {
      finalizeSave({ id: existingParty.id, name: existingParty.name }, phone, paid, andPrint);
      return;
    }
    // No match — this would previously auto-create a bare-bones party with
    // no phone/opening-balance recorded. Ask for the real details instead.
    setQuickAddParty({ name: partyName || `Party ${phone}`, phone, paid, andPrint });
  };

  const confirmQuickAddParty = (details: QuickAddPartyDetails) => {
    if (!quickAddParty) return;
    const name = details.name.trim() || quickAddParty.name;
    const phone = details.phone.trim();
    const { paid, andPrint } = quickAddParty;
    setQuickAddParty(null);
    // The name may have been EDITED inside the dialog — re-check so a
    // same-phone or same-name party (any capitalisation) is reused, never
    // duplicated. Mirrors confirmQuickAddItem.
    const match =
      (phone ? allParties.find((p) => (p.phone ?? "").trim() === phone) : undefined) ??
      allParties.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (match) {
      toast.info(`Using existing party: ${match.name}`);
      finalizeSave({ id: match.id, name: match.name }, phone, paid, andPrint);
      return;
    }
    const newParty: Party = {
      id: genId(),
      name,
      type: "both",
      phone: phone || undefined,
      address: details.address.trim() || undefined,
      openingBalance: details.openingBalance || 0,
      gstin: details.gstin.trim() || undefined,
      creditLimit: details.creditLimit || undefined,
      referredBy: details.referredBy,
      createdAt: new Date().toISOString(),
    };
    finalizeSave({ create: newParty }, phone, paid, andPrint);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") navigate({ to: isSale ? "/sales" : "/purchase" });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 md:px-5 py-3 border-b bg-card flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center justify-between gap-3 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`h-10 w-10 rounded-md flex items-center justify-center ${isSale ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}
            >
              {isSale ? <Receipt className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <h1 className="text-[17px] font-bold tracking-tight leading-tight">
                {existing ? "Edit" : "New"} {isSale ? "Sale Invoice" : "Purchase Bill"}
              </h1>
              <p className="text-[11px] text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">{inv.number}</span>
              </p>
            </div>
          </div>
          {isSale && (
            <label className="sm:hidden shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-md border bg-background cursor-pointer select-none">
              <input
                type="checkbox"
                checked={gstOn}
                onChange={toggleGst}
                className="accent-primary h-3.5 w-3.5"
              />
              <span className="text-[11px] font-semibold">GST Bill</span>
            </label>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap sm:justify-end">
          {/* Toggles — grouped together as one row so they read as a clean
              pair of switches instead of separate borderline-width chips
              each wrapping onto their own line. */}
          <div
            className={
              !isSale
                ? "grid grid-cols-2 gap-2 sm:flex sm:items-center sm:w-auto"
                : "flex items-center justify-end gap-2"
            }
          >
            {!isSale && (
              <label className="flex items-center justify-center gap-2 h-9 px-3 rounded-md border bg-background cursor-pointer select-none sm:justify-start sm:w-auto">
                <input
                  type="checkbox"
                  checked={!!inv.isInternational}
                  onChange={(e) => updateInternational({ isInternational: e.target.checked })}
                  className="accent-primary"
                />
                <span className="text-[12px] font-semibold whitespace-nowrap">
                  International Purchase
                </span>
              </label>
            )}
            {!isSale && (
              <label className="sm:hidden shrink-0 flex items-center gap-2 h-9 px-3 rounded-md border bg-background cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={gstOn}
                  onChange={toggleGst}
                  className="accent-primary"
                />
                <span className="text-[12px] font-semibold">GST Bill</span>
              </label>
            )}
          </div>

          {!isSale && inv.isInternational && (
            <>
              {/* Mobile: proper label-above-input fields in a 2-col grid —
                  reads as a form, not a squeezed inline pill. */}
              <div className="sm:hidden grid grid-cols-2 gap-2">
                <label
                  className="flex flex-col gap-1 px-2.5 py-2 rounded-md border bg-background"
                  title="How many rupees 1 unit of the supplier's currency is worth"
                >
                  <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                    Exchange Rate (₹)
                  </span>
                  <NumInput
                    value={inv.exchangeRate ?? 0}
                    onValue={(n) => updateInternational({ exchangeRate: n })}
                    className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 px-2.5 py-2 rounded-md border bg-background">
                  <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                    Carry cost/pc (₹)
                  </span>
                  <NumInput
                    value={inv.carryCostPerUnit ?? 0}
                    onValue={(n) => updateInternational({ carryCostPerUnit: n })}
                    className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                  />
                </label>
              </div>
              {/* Desktop: original compact inline pills, unchanged */}
              <label
                className="hidden sm:flex items-center gap-1.5 h-9 px-2.5 rounded-md border bg-background text-[12px]"
                title="How many rupees 1 unit of the supplier's currency is worth"
              >
                <span className="text-muted-foreground whitespace-nowrap">Exchange Rate (₹)</span>
                <NumInput
                  value={inv.exchangeRate ?? 0}
                  onValue={(n) => updateInternational({ exchangeRate: n })}
                  className="w-16 h-6 px-1 text-right border rounded bg-background focus:border-primary outline-none"
                />
              </label>
              <label className="hidden sm:flex items-center gap-1.5 h-9 px-2.5 rounded-md border bg-background text-[12px]">
                <span className="text-muted-foreground whitespace-nowrap">Carry cost/pc</span>
                <NumInput
                  value={inv.carryCostPerUnit ?? 0}
                  onValue={(n) => updateInternational({ carryCostPerUnit: n })}
                  className="w-16 h-6 px-1 text-right border rounded bg-background focus:border-primary outline-none"
                />
                <span className="text-muted-foreground">₹</span>
              </label>
            </>
          )}
          {/* GST toggle — desktop position */}
          <label className="hidden sm:flex items-center gap-2 h-9 px-3 rounded-md border bg-background cursor-pointer select-none">
            <input
              type="checkbox"
              checked={gstOn}
              onChange={toggleGst}
              className="accent-primary"
            />
            <span className="text-[12px] font-semibold">GST Bill</span>
          </label>
        </div>
      </div>

      <div className="p-4 md:p-5 space-y-4 overflow-auto flex-1 bg-muted/30">
        {/* Party + meta */}
        <div className="bg-card border rounded-lg shadow-card p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 mb-3">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              {isSale ? "Customer Details" : "Supplier Details"}
            </span>
            {inv.partyId ? (
              <span className="inline-flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] inline-flex items-center gap-1 text-success font-medium bg-success-soft px-2 py-0.5 rounded shrink-0">
                  ✓ Existing party
                </span>
                {partyBalance !== null && Math.abs(partyBalance) > 0.01 && (
                  <span
                    className={`text-[11px] font-semibold px-2 py-0.5 rounded shrink-0 ${partyBalance > 0 ? "text-destructive bg-destructive/10" : "text-success bg-success-soft"}`}
                  >
                    {partyBalance > 0
                      ? `${isSale ? "Receivable" : "Payable"}: ${fmtMoney(partyBalance)}`
                      : `Advance: ${fmtMoney(-partyBalance)}`}
                  </span>
                )}
              </span>
            ) : partyQ || phoneQ ? (
              <span className="text-[11px] inline-flex items-center gap-1 text-primary font-medium bg-primary-soft px-2 py-0.5 rounded self-start">
                <UserPlus className="h-3 w-3" /> New party — details asked on save
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="relative">
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground font-medium">
                  {isSale ? "Customer Name" : "Supplier Name"} *
                </span>
                <div className="flex gap-1">
                  <input
                    ref={partyRef}
                    value={partyQ}
                    onChange={(e) => {
                      setPartyQ(e.target.value);
                      setPartyOpen(true);
                      setPartyIdx(0);
                      if (inv.partyId) setInv({ ...inv, partyId: "", partyName: e.target.value });
                    }}
                    onFocus={() => setPartyOpen(true)}
                    onBlur={() => setTimeout(() => setPartyOpen(false), 150)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setPartyIdx((i) => Math.min(partySuggests.length - 1, i + 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setPartyIdx((i) => Math.max(0, i - 1));
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        if (partySuggests[partyIdx]) {
                          selectParty(partySuggests[partyIdx]);
                        } else phoneRef.current?.focus();
                      }
                    }}
                    className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none flex-1"
                    placeholder="Type name or search…"
                  />
                  {inv.partyId && (
                    <button
                      type="button"
                      onClick={clearParty}
                      className="h-9 w-9 rounded-md border bg-background hover:bg-accent text-muted-foreground flex items-center justify-center"
                      title="Clear"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </label>
              {partyOpen && partySuggests.length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-64 overflow-auto">
                  {partySuggests.map((p, i) => (
                    <div
                      key={p.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectParty(p);
                      }}
                      className={`px-3 py-2 text-sm cursor-pointer ${i === partyIdx ? "bg-accent" : "hover:bg-accent"}`}
                    >
                      <div className="font-semibold">{p.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {p.phone && <>📞 {p.phone}</>}
                        {p.phone && p.gstin && " · "}
                        {p.gstin && <>GSTIN: {p.gstin}</>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium">Phone Number</span>
              <input
                ref={phoneRef}
                value={phoneQ}
                onChange={(e) => {
                  const v = e.target.value;
                  setPhoneQ(v);
                  if (inv.partyId) setInv({ ...inv, partyId: "", partyPhone: v });
                  // Auto-match by phone (10 digits)
                  if (v.length >= 10) {
                    const match = allParties.find((p) => (p.phone ?? "").trim() === v.trim());
                    if (match) selectParty(match);
                  }
                }}
                className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none"
                placeholder="10-digit phone (auto-match)"
                inputMode="numeric"
              />
            </label>

            <Field
              id="inv-date"
              label="Bill Date"
              type="date"
              value={inv.date}
              onChange={(e) => setInv({ ...inv, date: e.target.value })}
            />

            <div className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium">
                {isSale ? "Invoice #" : "Bill #"}
              </span>
              <div className="flex items-center gap-1">
                {numberEditing ? (
                  <>
                    <input
                      ref={numberRef}
                      value={inv.number}
                      onChange={(e) => setInv({ ...inv, number: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") setNumberEditing(false);
                      }}
                      className="h-9 px-3 border-2 border-primary rounded-md bg-background focus:outline-none font-mono font-semibold text-primary flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setNumberEditing(false)}
                      className="h-9 w-9 flex items-center justify-center rounded-md border bg-success-soft text-success hover:opacity-80 transition flex-shrink-0"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="h-9 px-3 border rounded-md bg-muted flex items-center font-mono font-semibold text-muted-foreground flex-1">
                      {inv.number}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setNumberEditing(true);
                        setTimeout(() => numberRef.current?.focus(), 30);
                      }}
                      className="h-9 w-9 flex items-center justify-center rounded-md border bg-background hover:bg-accent text-muted-foreground hover:text-foreground transition flex-shrink-0"
                      title="Edit invoice number"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              <span className="text-[10px] text-muted-foreground">
                Auto-generated · click ✎ to edit
              </span>
            </div>
          </div>
        </div>

        {/* Line items — each blank row below the filled ones is its own
            search-and-add field (Vyapar-style), not a separate search bar */}
        <div className="border rounded-lg bg-card shadow-card">
          <div className="px-4 py-2.5 border-b bg-muted/50 flex items-center justify-between rounded-t-lg">
            <span className="text-[13px] font-semibold">Items ({inv.lineItems.length})</span>
            <span className="text-[11px] text-muted-foreground">
              Type an item name in a row below to add it
            </span>
          </div>
          <div className="overflow-x-auto rounded-b-lg">
            <table className="w-full text-[13px] min-w-[720px]">
              <thead className="text-[11px] text-muted-foreground uppercase tracking-wider">
                <tr className="bg-muted/40">
                  <th className="text-left px-3 py-2 w-8">#</th>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-right w-20 py-2 px-2">Qty</th>
                  <th className="text-left w-20 py-2 px-2">Unit</th>
                  {inv.isInternational && (
                    <th className="text-right w-28 py-2 px-2 whitespace-nowrap">Foreign Price</th>
                  )}
                  <th className="text-right w-24 py-2 px-2">Price</th>
                  <th className="text-right w-20 py-2 px-2">Disc%</th>
                  {gstOn && <th className="text-right w-20 py-2 px-2">GST%</th>}
                  <th className="text-right w-28 py-2 pr-3">Amount</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {inv.lineItems.map((l, idx) => (
                  <tr key={l.id} className="border-t hover:bg-accent/30">
                    <td className="px-3 py-1.5 text-muted-foreground text-[11px]">{idx + 1}</td>
                    <td className="px-3 py-1.5">
                      <ItemNameCell
                        name={l.name}
                        items={items}
                        isSale={isSale}
                        gstOn={gstOn}
                        onChange={(it) => changeLineItem(l.id, it)}
                      />
                    </td>
                    <td className="py-1.5 px-1">
                      <NumInput
                        id={`qty-${l.id}`}
                        value={l.qty}
                        onValue={(n) => updateLine(l.id, { qty: n })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            focusFirstPendingRow();
                          }
                        }}
                        className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-1">
                      <input
                        value={l.unit}
                        onChange={(e) => updateLine(l.id, { unit: e.target.value })}
                        className="w-full h-7 px-1.5 border rounded bg-background focus:border-primary outline-none"
                      />
                    </td>
                    {inv.isInternational && (
                      <td className="py-1.5 px-1">
                        <NumInput
                          value={l.foreignPrice ?? 0}
                          onValue={(n) => updateLine(l.id, { foreignPrice: n })}
                          className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                    )}
                    <td className="py-1.5 px-1 relative">
                      {inv.partyId ? (
                        <PriceHistoryCell
                          value={l.price}
                          onValue={(n) => updateLine(l.id, { price: n })}
                          history={partyItemHistory(l.itemId)}
                          partyName={inv.partyName}
                          isSale={isSale}
                        />
                      ) : (
                        <NumInput
                          value={l.price}
                          onValue={(n) => updateLine(l.id, { price: n })}
                          className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      )}
                    </td>
                    <td className="py-1.5 px-1">
                      <NumInput
                        value={l.discountPct}
                        onValue={(n) => updateLine(l.id, { discountPct: n })}
                        className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                      />
                    </td>
                    {gstOn && (
                      <td className="py-1.5 px-1">
                        <NumInput
                          value={l.gstRate}
                          onValue={(n) => updateLine(l.id, { gstRate: n })}
                          className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                    )}
                    <td className="text-right px-3 py-1.5 font-semibold tabular-nums">
                      {fmtMoney(l.amount)}
                    </td>
                    <td className="py-1.5 px-1">
                      <button
                        type="button"
                        onClick={() => removeLine(l.id)}
                        className="text-destructive p-1 hover:bg-destructive/10 rounded"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {pendingRowIds.map((id) => (
                  <ItemEntryRow
                    key={id}
                    items={items}
                    gstOn={gstOn}
                    isSale={isSale}
                    isInternational={!!inv.isInternational}
                    onAdd={(it) => {
                      focusQtyId.current = addLineItem(it);
                      completePendingRow(id);
                    }}
                    onAddNew={(name) => setQuickAddItem({ name, rowId: id })}
                    registerInput={(el) => {
                      pendingInputRefs.current[id] = el;
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Totals + notes */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          <div className="lg:col-span-2 border rounded-lg bg-card shadow-card overflow-hidden text-sm">
            {/* Amount breakdown */}
            <div className="p-4 space-y-2.5">
              <Row label="Subtotal" value={fmtMoney(inv.subtotal)} />
              {gstOn && <Row label="Tax (GST)" value={fmtMoney(inv.taxAmount)} />}
              <div className="flex justify-between items-center gap-2">
                <span className="text-muted-foreground">Extra Discount</span>
                <NumInput
                  value={inv.discount}
                  onValue={(n) => setDiscount(n)}
                  className="w-28 h-8 px-2 text-right border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none tabular-nums"
                />
              </div>
              {isSale && (
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground">Shipping Charge</span>
                  <NumInput
                    value={inv.shippingCharge ?? 0}
                    onValue={(n) => setShippingCharge(n)}
                    className="w-28 h-8 px-2 text-right border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none tabular-nums"
                  />
                </div>
              )}
              {isSale && cashbackAvailable > 0 && (
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground">
                    Redeem Cashback{" "}
                    <span className="text-[11px]">(Available: {fmtMoney(cashbackAvailable)})</span>
                  </span>
                  <NumInput
                    value={inv.redeemedCashback ?? 0}
                    onValue={(n) => setRedeemedCashback(n)}
                    className="w-28 h-8 px-2 text-right border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none tabular-nums"
                  />
                </div>
              )}
              {!!inv.roundOff && Math.abs(inv.roundOff) > 0.001 && (
                <Row
                  label="Round Off"
                  value={`${inv.roundOff > 0 ? "+" : "−"}${fmtMoney(Math.abs(inv.roundOff))}`}
                />
              )}
              {referralPreview && referralPreview.disabled && (
                <div className="flex justify-between items-center gap-2 -mx-4 px-4 py-2 bg-amber-50 text-[12px] text-amber-700">
                  <span>
                    {inv.partyName || "This party"} is linked to referrer {referralPreview.referrerName}, but
                    referral commission is OFF in Settings — no bonus will be earned on this bill.
                  </span>
                </div>
              )}
              {referralPreview && !referralPreview.disabled && (
                <div className="flex justify-between items-center gap-2 -mx-4 px-4 py-2 bg-accent/40 text-[12px]">
                  <span className="text-muted-foreground">
                    Referral bonus (internal, not printed) — {inv.partyName || "this party"} &{" "}
                    {referralPreview.referrerName} each earn
                  </span>
                  <span className="font-semibold tabular-nums shrink-0">
                    {fmtMoney(referralPreview.commission)}
                  </span>
                </div>
              )}
            </div>

            {/* Total — its own band so it reads as the one number that matters */}
            <div className="flex justify-between items-center gap-2 px-4 py-3 bg-muted/40 border-y font-bold text-lg">
              <span>Total</span>
              <span className="tabular-nums text-primary">{fmtMoney(inv.total)}</span>
            </div>

            {/* Payment */}
            <div className="p-4 space-y-2.5">
              <div className="flex justify-between items-center gap-2">
                <span className="text-muted-foreground">Payment Mode</span>
                <ModePills
                  value={inv.paymentMode}
                  onChange={(newMode: PaymentMode) => {
                    setInv({
                      ...inv,
                      paymentMode: newMode,
                      paid: newMode === "credit" ? 0 : inv.paid,
                      bankId: newMode === "bank" ? inv.bankId : undefined,
                    });
                  }}
                  modes={["cash", "bank", "credit"]}
                />
              </div>
              {inv.paymentMode === "bank" && (
                <div className="relative flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-[12px]">Bank Account *</span>
                  <input
                    ref={bankSelectRef}
                    value={bankQ}
                    onChange={(e) => {
                      setBankQ(e.target.value);
                      setBankOpen(true);
                      setBankIdx(0);
                      if (inv.bankId) setInv({ ...inv, bankId: undefined });
                    }}
                    onFocus={() => setBankOpen(true)}
                    onBlur={() => setTimeout(() => setBankOpen(false), 150)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setBankIdx((i) => Math.min(bankSuggests.length - 1, i + 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setBankIdx((i) => Math.max(0, i - 1));
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        if (bankSuggests[bankIdx]) {
                          selectBank(bankSuggests[bankIdx]);
                        }
                      }
                    }}
                    placeholder="Search bank account…"
                    className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none text-[13px]"
                  />
                  {bankOpen && bankSuggests.length > 0 && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-56 overflow-auto">
                      {bankSuggests.map((b, i) => (
                        <div
                          key={b.id}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectBank(b);
                          }}
                          className={`px-3 py-2 text-sm cursor-pointer ${i === bankIdx ? "bg-accent" : "hover:bg-accent"}`}
                        >
                          {b.name}
                          {b.accountNumber ? ` — ${b.accountNumber}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                  {bankOpen && bankQ && bankSuggests.length === 0 && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated px-3 py-2 text-xs text-muted-foreground">
                      No matching bank account
                    </div>
                  )}
                  {banks.length === 0 && (
                    <p className="text-[11px] text-amber-600">
                      No bank accounts set up yet — add one from Bank Accounts first.
                    </p>
                  )}
                </div>
              )}
              <div className="flex justify-between items-center gap-2 pt-1">
                <span className="text-muted-foreground">
                  {mode === "sale" ? "Received Amount" : "Paid Amount"}
                </span>
                {inv.paymentMode === "credit" ? (
                  <span className="text-[12px] text-muted-foreground select-none">
                    ₹0.00 — {mode === "sale" ? "will receive later" : "will pay later"}
                  </span>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        // Safari doesn't focus a clicked <button> by default
                        // (Chrome/Firefox do) — force it so Tab/Enter still
                        // continues the form flow from here on Safari too.
                        e.currentTarget.focus();
                        setInv({ ...inv, paid: inv.total });
                      }}
                      className="h-8 px-2.5 rounded-md border bg-success-soft text-success text-[11px] font-semibold hover:opacity-80 focus:ring-2 focus:ring-ring/20 outline-none transition"
                      title="Received full amount"
                    >
                      Full
                    </button>
                    <NumInput
                      value={inv.paid}
                      onValue={(n) => setInv({ ...inv, paid: n })}
                      className="w-24 h-8 px-2 text-right border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none tabular-nums"
                    />
                  </div>
                )}
              </div>
              <div className="flex justify-between items-center gap-2 pt-2 mt-1 border-t font-semibold">
                <span>Balance Due</span>
                <span
                  className={`tabular-nums ${inv.total - inv.paid > 0 ? "text-destructive" : "text-success"}`}
                >
                  {fmtMoney(Math.max(0, inv.total - inv.paid))}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-card border rounded-lg shadow-card p-4">
            <label className="flex flex-col gap-1.5 text-[12px] h-full">
              <span className="text-muted-foreground font-medium uppercase text-[11px] tracking-wider">
                Notes / Terms
                <span className="normal-case font-normal text-muted-foreground/70">
                  {" "}
                  (optional)
                </span>
              </span>
              <textarea
                value={inv.notes ?? ""}
                onChange={(e) => setInv({ ...inv, notes: e.target.value })}
                placeholder="Add any note or terms & conditions…"
                className="flex-1 min-h-[140px] px-3 py-2 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none resize-none"
              />
            </label>
          </div>
        </div>
      </div>

      {/* Bottom action bar — kept last in DOM/tab order on purpose: the whole
          form (party, items, totals, notes) is fully keyboard-navigable via
          Tab, and this is where that flow naturally lands to save. */}
      <div className="px-4 md:px-5 py-3 border-t bg-card flex items-center gap-2">
        {/* Keyboard hint is meaningless on a touchscreen — desktop only */}
        <span className="hidden md:inline text-[11px] text-muted-foreground mr-auto">
          Tab/Enter to move · Ctrl+S save · Esc cancel
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ to: isSale ? "/sales" : "/purchase" })}
          className="shrink-0"
        >
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => save(true)}
          disabled={saving}
          className="shrink-0"
        >
          <Printer className="h-3.5 w-3.5" /> Save & Print
        </Button>
        <Button
          size="sm"
          onClick={() => save()}
          disabled={saving}
          className="flex-1 md:flex-none bg-primary text-primary-foreground"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <PrintableInvoice
        inv={inv}
        company={company}
        mode={mode}
        codeByLine={itemCodesByLine(inv.lineItems)}
      />
      <QuickAddPartyDialog
        draft={quickAddParty}
        isSale={isSale}
        existingParties={allParties}
        onCancel={() => setQuickAddParty(null)}
        onPickExisting={(p) => {
          setQuickAddParty(null);
          selectParty(p);
        }}
        onConfirm={confirmQuickAddParty}
      />
      <QuickAddItemDialog
        draft={quickAddItem}
        isSale={isSale}
        existingItems={items}
        onCancel={() => setQuickAddItem(null)}
        onPickExisting={(it) => {
          if (!quickAddItem) return;
          focusQtyId.current = addLineItem(it);
          completePendingRow(quickAddItem.rowId);
          setQuickAddItem(null);
        }}
        onConfirm={confirmQuickAddItem}
      />
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function ItemEntryRow({
  items,
  onAdd,
  onAddNew,
  gstOn,
  isSale,
  isInternational,
  registerInput,
}: {
  items: Item[];
  onAdd: (i: Item) => void;
  onAddNew: (name: string) => void;
  gstOn: boolean;
  isSale: boolean;
  isInternational: boolean;
  registerInput: (el: HTMLInputElement | null) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  const [dropdownRect, setDropdownRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // The row lives inside a horizontally-scrollable table
  // (overflow-x-auto), which per the CSS spec also forces overflow-y to
  // "auto" once overflow-x isn't "visible" — so a plain absolutely
  // positioned dropdown gets silently clipped by the table's own scroll
  // box. Render it through a portal instead, positioned in viewport
  // coordinates from the input's own rect, so it floats above everything.
  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = inputElRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setDropdownRect({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  // Empty query — browse the full item catalog (like a combobox), instead
  // of showing nothing until the user starts typing. Enter always commits
  // whichever row is highlighted (index 0 by default), matching what's
  // visually shown as selected.
  const suggests = q.trim()
    ? items
        .filter(
          (i) =>
            i.name.toLowerCase().includes(q.toLowerCase()) ||
            i.sku?.toLowerCase().includes(q.toLowerCase()) ||
            i.barcode?.includes(q),
        )
        .slice(0, 8)
    : items.slice(0, 8);

  // Offer "add as new item" whenever the typed name doesn't exactly match an existing one
  const trimmed = q.trim();
  const showAddNew =
    trimmed.length > 0 && !items.some((i) => i.name.trim().toLowerCase() === trimmed.toLowerCase());
  const optionCount = suggests.length + (showAddNew ? 1 : 0);

  // No local reset()/refocus here — once an item is added this row is
  // retired by the parent (a fresh blank row takes its id's place), and the
  // parent moves focus to the new line's Qty field, not back into this row.
  const pick = (it: Item) => onAdd(it);
  const pickNew = () => onAddNew(trimmed);
  const choose = (i: number) => {
    if (i < suggests.length) pick(suggests[i]);
    else if (showAddNew) pickNew();
  };

  return (
    <tr className="border-t hover:bg-accent/20">
      <td className="px-3 py-1.5"></td>
      <td className="px-3 py-1.5">
        <input
          ref={(el) => {
            inputElRef.current = el;
            registerInput(el);
          }}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(optionCount - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (optionCount > 0) choose(idx);
            }
          }}
          placeholder="Type item name to add…"
          className="w-full h-8 px-2 border rounded bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none text-sm"
        />
        {open &&
          optionCount > 0 &&
          dropdownRect &&
          createPortal(
            <div
              style={{
                position: "fixed",
                top: dropdownRect.top,
                left: dropdownRect.left,
                width: dropdownRect.width,
              }}
              className="z-50 border rounded-md bg-popover shadow-elevated max-h-72 overflow-auto"
            >
              {suggests.map((it, i) => (
                <div
                  key={it.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(it);
                  }}
                  className={`px-3 py-2 text-sm cursor-pointer flex justify-between ${i === idx ? "bg-accent" : "hover:bg-accent"}`}
                >
                  <div>
                    <div className="font-semibold">{it.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      Stock: {it.stock} {it.unit}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold tabular-nums">
                      {fmtMoney(isSale ? it.salePrice || it.purchasePrice : it.purchasePrice)}
                    </div>
                    {gstOn && (
                      <div className="text-[11px] text-muted-foreground">GST {it.gstRate}%</div>
                    )}
                  </div>
                </div>
              ))}
              {showAddNew && (
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickNew();
                  }}
                  className={`px-3 py-2 text-sm cursor-pointer flex items-center gap-2 border-t ${idx === suggests.length ? "bg-accent" : "hover:bg-accent"}`}
                >
                  <span className="h-5 w-5 rounded bg-primary-soft text-primary flex items-center justify-center text-xs font-bold">
                    +
                  </span>
                  <span>
                    Add "<span className="font-semibold">{trimmed}</span>" as new item
                  </span>
                </div>
              )}
            </div>,
            document.body,
          )}
      </td>
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      {isInternational && (
        <td className="py-1.5 px-1">
          <input
            disabled
            className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
          />
        </td>
      )}
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      {gstOn && (
        <td className="py-1.5 px-1">
          <input
            disabled
            className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
          />
        </td>
      )}
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      <td className="py-1.5 px-1"></td>
    </tr>
  );
}

function ItemNameCell({
  name,
  items,
  isSale,
  gstOn,
  onChange,
}: {
  name: string;
  items: Item[];
  isSale: boolean;
  gstOn: boolean;
  onChange: (it: Item) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!editing) return;
    const updateRect = () => {
      const el = inputElRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 240) });
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [editing]);

  const startEdit = () => {
    setQ("");
    setIdx(0);
    setEditing(true);
  };

  const suggests = q.trim()
    ? items
        .filter(
          (i) =>
            i.name.toLowerCase().includes(q.toLowerCase()) ||
            i.sku?.toLowerCase().includes(q.toLowerCase()) ||
            i.barcode?.includes(q),
        )
        .slice(0, 8)
    : items.slice(0, 8);

  const pick = (it: Item) => {
    setEditing(false);
    const focusId = onChange(it);
    setTimeout(() => {
      const qtyEl = document.getElementById(`qty-${focusId}`) as HTMLInputElement | null;
      qtyEl?.focus();
    }, 0);
  };

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        title="Click to change item"
        onClick={startEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter") startEdit();
        }}
        className="font-medium cursor-pointer hover:underline hover:text-primary"
      >
        {name}
      </div>
    );
  }

  return (
    <>
      <input
        ref={inputElRef}
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIdx(0);
        }}
        onBlur={() => setTimeout(() => setEditing(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setIdx((i) => Math.min(suggests.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (suggests[idx]) pick(suggests[idx]);
          }
        }}
        placeholder="Type to change item…"
        className="w-full h-7 px-1.5 border rounded bg-background focus:border-primary outline-none text-sm"
      />
      {rect &&
        createPortal(
          <div
            style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}
            className="z-50 border rounded-md bg-popover shadow-elevated max-h-72 overflow-auto"
          >
            {suggests.length === 0 && (
              <div className="px-3 py-3 text-[12px] text-muted-foreground text-center">
                No items found
              </div>
            )}
            {suggests.map((it, i) => (
              <div
                key={it.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(it);
                }}
                className={`px-3 py-2 text-sm cursor-pointer flex justify-between ${i === idx ? "bg-accent" : "hover:bg-accent"}`}
              >
                <div>
                  <div className="font-semibold">{it.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Stock: {it.stock} {it.unit}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums">
                    {fmtMoney(isSale ? it.salePrice || it.purchasePrice : it.purchasePrice)}
                  </div>
                  {gstOn && (
                    <div className="text-[11px] text-muted-foreground">GST {it.gstRate}%</div>
                  )}
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function PriceHistoryCell({
  value,
  onValue,
  history,
  partyName,
  isSale,
}: {
  value: number;
  onValue: (n: number) => void;
  history: { date: string; qty: number; price: number }[];
  partyName: string;
  isSale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  const [rect, setRect] = useState<{
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  // Same portal trick as ItemEntryRow's dropdown — this cell lives inside
  // the overflow-x-auto item table, so a plain absolutely positioned popup
  // gets clipped by the table's own scroll box.
  //
  // PHONES DELIBERATELY DO NOT ANCHOR TO THE INPUT. When the numeric keyboard
  // opens, iOS scrolls the visual viewport inside the layout viewport, but
  // `position: fixed` still resolves against the LAYOUT viewport — so a box
  // pinned to the input's measured rect drifts far away from it (it was
  // landing up beside the Bill Date field). Chasing that with corrections
  // means tracking two viewports through focus, scroll, keyboard-open and
  // rotation, and getting any one of them wrong puts the popup off-screen
  // again. Instead the phone layout ignores the input entirely and sits as a
  // full-width sheet just above the keyboard: always in the same predictable
  // place, always thumb-reachable, nothing to drift.
  //
  // Desktop keeps the original anchored popup — right-aligned 256px under the
  // input, byte-for-byte the placement that already works there.
  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = inputElRef.current;
      if (!el) return;
      const vv = window.visualViewport;
      const vLeft = vv?.offsetLeft ?? 0;
      const vTop = vv?.offsetTop ?? 0;
      const vw = vv?.width ?? window.innerWidth;
      const vh = vv?.height ?? window.innerHeight;
      const GAP = 8;

      if (vw < 640) {
        // Distance from the layout viewport's bottom edge up to the visual
        // viewport's bottom edge — i.e. exactly the height the keyboard is
        // covering. Pinning `bottom` to that keeps the sheet resting on top
        // of the keyboard whether it's open or closed.
        const keyboard = Math.max(0, window.innerHeight - (vTop + vh));
        setRect({
          left: vLeft + GAP,
          width: vw - GAP * 2,
          bottom: keyboard + GAP,
          maxHeight: Math.min(260, vh - GAP * 2),
        });
        return;
      }

      const r = el.getBoundingClientRect();
      setRect({
        left: r.right - 256,
        width: 256,
        top: r.bottom + 4,
        maxHeight: Math.max(96, vTop + vh - r.bottom - GAP),
      });
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    window.visualViewport?.addEventListener("resize", updateRect);
    window.visualViewport?.addEventListener("scroll", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
      window.visualViewport?.removeEventListener("resize", updateRect);
      window.visualViewport?.removeEventListener("scroll", updateRect);
    };
  }, [open]);

  return (
    <>
      <NumInput
        ref={inputElRef}
        value={value}
        onValue={onValue}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
      />
      {open &&
        rect &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              maxHeight: rect.maxHeight,
            }}
            className="z-50 border rounded-md bg-popover shadow-elevated overflow-y-auto overscroll-contain"
          >
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted/50 border-b">
              Last {isSale ? "Sale" : "Purchase"} Prices — {partyName}
            </div>
            {!history.length ? (
              <div className="px-3 py-3 text-[12px] text-muted-foreground text-center">
                No previous transaction found
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-3 gap-2 px-3 py-1 text-[10px] font-semibold uppercase text-muted-foreground border-b">
                  <span>Date</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Price</span>
                </div>
                {history.map((h, i) => (
                  <button
                    type="button"
                    key={i}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onValue(h.price);
                      setOpen(false);
                    }}
                    // Roomier rows on the phone sheet — these are thumb
                    // targets there, not mouse targets. Unchanged on sm+.
                    className="w-full grid grid-cols-3 gap-2 px-3 py-2.5 sm:py-1.5 text-[13px] sm:text-[12px] text-left hover:bg-accent active:bg-accent border-b last:border-0"
                  >
                    <span className="text-muted-foreground">{fmtDate(h.date)}</span>
                    <span className="text-right tabular-nums">{h.qty}</span>
                    <span className="text-right tabular-nums font-semibold">
                      {fmtMoney(h.price)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function QuickAddItemDialog({
  draft,
  isSale,
  existingItems = [],
  onCancel,
  onPickExisting,
  onConfirm,
}: {
  draft: { name: string; rowId: string } | null;
  isSale: boolean;
  existingItems?: Item[];
  onCancel: () => void;
  onPickExisting?: (it: Item) => void;
  onConfirm: (details: {
    name: string;
    sku: string;
    unit: string;
    gstRate: number;
    salePrice: number;
    purchasePrice: number;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState("pcs");
  const [gstRate, setGstRate] = useState(0);
  const [salePrice, setSalePrice] = useState(0);
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [nameOpen, setNameOpen] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft) {
      setName(draft.name);
      setSku("");
      setUnit("pcs");
      setGstRate(0);
      setSalePrice(0);
      setPurchasePrice(0);
      setNameOpen(false);
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [draft]);

  if (!draft) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    onConfirm({ name, sku, unit, gstRate, salePrice, purchasePrice });
  };

  // Live "does this already exist?" hint — the name typed at the counter
  // didn't exactly match anyone, but if they edit it here into something
  // close to an existing item, flag it before a near-duplicate gets created.
  const nameQ = name.trim().toLowerCase();
  const similarItemsAll = nameQ
    ? existingItems.filter((it) => it.name.trim().toLowerCase().includes(nameQ))
    : [];
  const similarItems = similarItemsAll.slice(0, 5);

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            New Item
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-2">
          "{draft.name}" isn't in your items list yet — set its price & GST before adding it to this{" "}
          {isSale ? "invoice" : "bill"}.
        </p>
        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 relative">
            <Field
              ref={firstRef}
              label="Name *"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameOpen(true);
              }}
              onFocus={() => setNameOpen(true)}
              onBlur={() => setTimeout(() => setNameOpen(false), 150)}
              autoComplete="off"
            />
            {nameOpen && similarItems.length > 0 && (
              <div className="absolute z-30 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-52 overflow-auto">
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border-b flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3" />
                  {similarItemsAll.length === 1 ? "Similar item exists" : "Similar items exist"} —
                  click to use it instead
                </div>
                {similarItems.map((it) => (
                  <div
                    key={it.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPickExisting?.(it);
                      setNameOpen(false);
                    }}
                    className="px-3 py-2 text-sm cursor-pointer hover:bg-accent flex items-center justify-between"
                  >
                    <span className="font-medium">{it.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      Stock: {it.stock} {it.unit}
                    </span>
                  </div>
                ))}
                {similarItemsAll.length > similarItems.length && (
                  <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-t">
                    +{similarItemsAll.length - similarItems.length} more match
                    {similarItemsAll.length - similarItems.length > 1 ? "es" : ""}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Short shop code — this is what fills the Code column on the
              printed bill. Set here so an item created mid-billing isn't
              left without one. */}
          <Field
            label="Item Code"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            hint="Printed in the Code column"
          />
          <Field label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
          <NumField
            label="GST Rate (%)"
            value={gstRate}
            onValue={(n) => setGstRate(Math.max(0, n))}
          />
          <NumField
            label={isSale ? "Sale Price *" : "Purchase Price *"}
            value={isSale ? salePrice : purchasePrice}
            onValue={(n) => {
              const v = Math.max(0, n);
              if (isSale) setSalePrice(v);
              else setPurchasePrice(v);
            }}
          />
          <NumField
            label={isSale ? "Purchase Price" : "Sale Price"}
            value={isSale ? purchasePrice : salePrice}
            onValue={(n) => {
              const v = Math.max(0, n);
              if (isSale) setPurchasePrice(v);
              else setSalePrice(v);
            }}
          />
          <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Add & Continue</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
