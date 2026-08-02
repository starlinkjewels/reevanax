import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/components/Pagination";
import { ExpenseRepo, BankRepo, PayeeRepo, CompanyRepo } from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { newBatch, commitBatch, genId } from "@/repositories/base";
import type { Expense, BankAccount, Payee } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumField } from "@/components/NumInput";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { ModePills, fmtMode } from "@/components/ModePills";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import { Plus, Receipt, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/expenses")({ component: ExpensesPage });

function ExpensesPage() {
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("purchaseExpenses");
  const deleteAllowed = isOwner || canDelete("purchaseExpenses");
  const [rows, setRows] = useState<Expense[]>([]);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Expense | null>(null);
  const refresh = () => setRows(ExpenseRepo.all());
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  const pg = usePagination(rows);

  const total = rows.reduce((s, r) => s + r.amount, 0);

  const handleDelete = (r: Expense) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete expenses");
      return;
    }
    if (confirm("Delete expense?")) {
      // Bail if another device already deleted it — the bank reversal below is
      // a blind atomic increment, so running it twice would add the money back
      // to the account twice.
      const live = ExpenseRepo.get(r.id);
      if (!live) {
        toast.info("This expense was already deleted");
        refresh();
        return;
      }
      // Money that was taken off a specific bank account when this
      // expense was recorded must be moved back on, or the account
      // balance stays permanently wrong after the expense is gone.
      const batch = newBatch();
      if (live.paymentMode === "bank" && live.bankId && BankRepo.get(live.bankId)) {
        BankRepo.adjustFieldBatched(batch, live.bankId, "balance", live.amount);
      }
      ExpenseRepo.removeBatched(batch, live.id);
      commitBatch(batch, "delete expense");
      refresh();
      toast.success("Deleted");
    }
  };

  const columns: Column<Expense>[] = [
    {
      key: "date",
      label: "Date",
      width: "120px",
      render: (r) => fmtDate(r.date),
      sortValue: (r) => r.date,
    },
    { key: "category", label: "Category", width: "160px", render: (r) => r.category },
    {
      key: "payee",
      label: "Paid To",
      width: "160px",
      render: (r) => r.payeeName ?? "—",
      sortValue: (r) => r.payeeName ?? "",
    },
    { key: "notes", label: "Notes", render: (r) => r.notes ?? "—" },
    {
      key: "mode",
      label: "Mode",
      width: "80px",
      render: (r) => <span className="text-xs">{fmtMode(r.paymentMode)}</span>,
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      width: "120px",
      render: (r) => fmtMoney(r.amount),
      sortValue: (r) => r.amount,
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Expenses"
        subtitle={`${rows.length} entries · ${fmtMoney(total)} total`}
        icon={<Receipt className="h-5 w-5" />}
        iconClassName="text-warning"
        actions={
          editAllowed && (
            <Button
              size="sm"
              onClick={() => {
                setEdit(null);
                setOpen(true);
              }}
              className="w-full sm:w-auto"
            >
              <Plus className="h-3.5 w-3.5" /> New Expense
            </Button>
          )
        }
      />
      {/* Mobile card list — a table of 6 columns doesn't fit a phone; this
          is the same data as one tappable card per expense instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Receipt className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No expenses found</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => (
              <div
                key={r.id}
                onClick={() => {
                  if (!editAllowed) return;
                  setEdit(r);
                  setOpen(true);
                }}
                className={`bg-white px-4 py-3 flex items-center gap-3 ${editAllowed ? "active:bg-gray-50 cursor-pointer" : ""}`}
              >
                <div className="h-9 w-9 rounded-full flex items-center justify-center shrink-0 bg-rose-50 text-rose-600">
                  <Receipt className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-[13px] text-gray-800 truncate leading-tight">
                      {r.category}
                    </p>
                    <p className="font-bold text-[13px] text-rose-600 tabular-nums shrink-0 leading-tight">
                      −{fmtMoney(r.amount)}
                    </p>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1 truncate">
                    {fmtDate(r.date)} · {r.payeeName ?? "—"} · {fmtMode(r.paymentMode)}
                    {r.notes ? ` · ${r.notes}` : ""}
                  </p>
                </div>
                {deleteAllowed && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(r);
                    }}
                    className="p-1.5 rounded hover:bg-rose-50 text-gray-300 hover:text-rose-500 transition shrink-0 -mr-1.5"
                    title="Delete expense"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Table (desktop) */}
      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          activateOnClick={editAllowed}
          onRowActivate={
            editAllowed
              ? (r) => {
                  setEdit(r);
                  setOpen(true);
                }
              : undefined
          }
          onDelete={handleDelete}
        />
      </div>
      <ExpenseDialog open={open} onOpenChange={setOpen} expense={edit} onSaved={refresh} />
    </div>
  );
}

function ExpenseDialog({
  open,
  onOpenChange,
  expense,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  expense: Expense | null;
  onSaved: () => void;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const [f, setF] = useState<Partial<Expense>>({});
  const [saving, setSaving] = useState(false);
  // Synchronous double-submit guard — prevents a same-tick double Enter from
  // recording the expense (and its bank-balance move) twice.
  const savingRef = useRef(false);
  const [banks] = useState(() => BankRepo.all());
  const [payees, setPayees] = useState<Payee[]>([]);
  const [categories] = useState(() => CompanyRepo.get().expenseCategories ?? []);
  // An older expense's category can be a free-text value from before this
  // list existed, or one an admin has since removed — keep it selectable
  // (rather than silently blanking it out) so editing never loses data.
  const categoryOptions =
    f.category && !categories.includes(f.category) ? [f.category, ...categories] : categories;
  useEffect(() => {
    if (open) {
      setF(expense ?? { date: today(), paymentMode: "cash", amount: 0, category: "" });
      setPayees(PayeeRepo.all());
      setPayeeQ(expense?.payeeName ?? "");
      setSaving(false);
      savingRef.current = false;
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [open, expense]);

  // Search-as-you-type for Bank Account — same combobox as the Sales/
  // Purchase bill's bank picker, since a shop can have many accounts and a
  // plain dropdown makes them scroll-hunt for one.
  const [bankQ, setBankQ] = useState("");
  const [bankOpen, setBankOpen] = useState(false);
  const [bankIdx, setBankIdx] = useState(0);
  useEffect(() => {
    setBankQ(banks.find((b) => b.id === f.bankId)?.name ?? "");
  }, [f.bankId, banks]);
  const bankSuggests = banks.filter((b) => {
    const q = bankQ.trim().toLowerCase();
    if (!q) return true;
    return b.name.toLowerCase().includes(q) || (b.accountNumber ?? "").toLowerCase().includes(q);
  });
  const selectBank = (b: BankAccount) => {
    setF({ ...f, bankId: b.id });
    setBankQ(b.name);
    setBankOpen(false);
  };

  // Search-as-you-type for Payee — same combobox again. Unlike Bank Account,
  // typing a name that doesn't match anyone is valid: it creates a new
  // payee on save (mirrors how Sales/Purchase silently creates a new Party
  // for an unrecognized name), since a payee is just a name, nothing more.
  const [payeeQ, setPayeeQ] = useState("");
  const [payeeOpen, setPayeeOpen] = useState(false);
  const [payeeIdx, setPayeeIdx] = useState(0);
  const payeeSuggests = payees.filter((p) => {
    const q = payeeQ.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q);
  });
  const selectPayee = (p: Payee) => {
    setF({
      ...f,
      payeeId: p.id,
      payeeName: p.name,
      // Only pre-fill Category from the payee's default when the field is
      // still empty — never clobber a category the user already typed.
      category: f.category?.trim() ? f.category : (p.defaultCategory ?? f.category),
    });
    setPayeeQ(p.name);
    setPayeeOpen(false);
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    if (!f.category?.trim()) {
      toast.error("Category required");
      return;
    }
    if (!f.amount || f.amount <= 0) {
      toast.error("Amount must be positive");
      return;
    }
    if (f.paymentMode === "bank" && !f.bankId) {
      toast.error("Select which bank account this was paid from");
      return;
    }
    if (!payeeQ.trim()) {
      toast.error("Select or type who this was paid to");
      return;
    }
    savingRef.current = true;
    setSaving(true);

    // Bank-balance changes, a possibly-new payee, and the expense record
    // itself must all land together — a shared batch commits them
    // atomically instead of independent writes that could partially fail.
    const batch = newBatch();

    // Editing: reverse the old bank-account effect first, before applying
    // the new one below — handles both "same account, new amount" and
    // "switched to a different account" correctly.
    if (expense?.paymentMode === "bank" && expense.bankId && BankRepo.get(expense.bankId)) {
      BankRepo.adjustFieldBatched(batch, expense.bankId, "balance", expense.amount);
    }
    // Money paid out of the selected bank account for this (new) expense.
    if (f.paymentMode === "bank" && f.bankId) {
      BankRepo.adjustFieldBatched(batch, f.bankId, "balance", -f.amount);
    }

    // f.payeeId is only trusted if it was set by an actual pick from the
    // list — the input's onChange clears it the moment the text is edited
    // (same as the bank field), so a stale id from a previous selection can
    // never get silently attached to a different typed name. A typed name
    // that doesn't match anyone becomes a new payee — mirrors how Sales/
    // Purchase silently creates a new Party for an unrecognized name.
    const payeeName = payeeQ.trim();
    let payeeId = f.payeeId;
    if (!payeeId) {
      const match = payees.find((p) => p.name.toLowerCase() === payeeName.toLowerCase());
      payeeId = match?.id ?? genId();
      if (!match) {
        PayeeRepo.addBatched(batch, { id: payeeId, name: payeeName, defaultCategory: f.category });
      }
    }

    const record: Partial<Expense> = {
      ...f,
      bankId: f.paymentMode === "bank" ? f.bankId : undefined,
      payeeId,
      payeeName,
    };
    if (expense) {
      ExpenseRepo.updateBatched(batch, expense.id, record);
      toast.success("Updated");
    } else {
      ExpenseRepo.addBatched(batch, record as Omit<Expense, "id" | "createdAt">);
      toast.success("Saved");
    }
    commitBatch(batch, "save expense");
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{expense ? "Edit Expense" : "New Expense"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">Category *</span>
            <Select
              value={f.category || undefined}
              onValueChange={(v) => setF({ ...f, category: v })}
            >
              <SelectTrigger ref={firstRef} className="h-8 text-sm">
                <SelectValue placeholder="Select category…" />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {categoryOptions.length === 0 && (
              <p className="text-[11px] text-amber-600">
                No categories set up yet — add one from Settings first.
              </p>
            )}
          </label>
          <div className="relative flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">Paid To *</span>
            <input
              value={payeeQ}
              onChange={(e) => {
                setPayeeQ(e.target.value);
                setPayeeOpen(true);
                setPayeeIdx(0);
                if (f.payeeId) setF({ ...f, payeeId: undefined });
              }}
              onFocus={() => setPayeeOpen(true)}
              onBlur={() => setTimeout(() => setPayeeOpen(false), 150)}
              onKeyDown={(ev) => {
                if (ev.key === "ArrowDown") {
                  ev.preventDefault();
                  setPayeeIdx((i) => Math.min(payeeSuggests.length - 1, i + 1));
                } else if (ev.key === "ArrowUp") {
                  ev.preventDefault();
                  setPayeeIdx((i) => Math.max(0, i - 1));
                } else if (ev.key === "Enter") {
                  ev.preventDefault();
                  if (payeeSuggests[payeeIdx]) {
                    selectPayee(payeeSuggests[payeeIdx]);
                  }
                }
              }}
              placeholder="Employee, landlord, vendor…"
              className="h-8 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none text-sm"
            />
            {payeeOpen && payeeSuggests.length > 0 && (
              <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-56 overflow-auto">
                {payeeSuggests.map((p, i) => (
                  <div
                    key={p.id}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      selectPayee(p);
                    }}
                    className={`px-3 py-2 text-sm cursor-pointer ${i === payeeIdx ? "bg-accent" : "hover:bg-accent"}`}
                  >
                    {p.name}
                  </div>
                ))}
              </div>
            )}
            {payeeOpen && payeeSuggests.length === 0 && payeeQ.trim() && (
              <p className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated px-3 py-2 text-xs text-primary">
                New payee — "{payeeQ.trim()}" will be added
              </p>
            )}
          </div>
          <Field
            label="Date"
            type="date"
            value={f.date ?? today()}
            onChange={(e) => setF({ ...f, date: e.target.value })}
          />
          <NumField
            label="Amount *"
            value={f.amount ?? 0}
            onValue={(n) => setF({ ...f, amount: n })}
          />
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">Payment Mode</span>
            <div className="flex items-center h-8">
              <ModePills
                value={f.paymentMode ?? "cash"}
                onChange={(m) => {
                  setF({ ...f, paymentMode: m, bankId: m === "bank" ? f.bankId : undefined });
                }}
                modes={["cash", "bank"]}
              />
            </div>
          </label>
          {f.paymentMode === "bank" && (
            <div className="relative flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium">Bank Account *</span>
              <input
                value={bankQ}
                onChange={(e) => {
                  setBankQ(e.target.value);
                  setBankOpen(true);
                  setBankIdx(0);
                  if (f.bankId) setF({ ...f, bankId: undefined });
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
                className="h-8 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none text-sm"
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
          <div className="sm:col-span-2">
            <Field
              label="Notes"
              value={f.notes ?? ""}
              onChange={(e) => setF({ ...f, notes: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
