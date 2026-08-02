import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  SalesRepo,
  PurchaseRepo,
  ExpenseRepo,
  PaymentRepo,
  CashAdjustmentRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { cashFlows, type FlowEntry } from "@/lib/ledger";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import { DataTable } from "@/components/DataTable";
import { usePagination } from "@/components/Pagination";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumField } from "@/components/NumInput";
import { Banknote, Search, Calendar, X, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/cash")({ component: CashPage });

function CashPage() {
  const { isOwner, canEdit } = usePermissions();
  const editAllowed = isOwner || canEdit("cashBank");
  const [entries, setEntries] = useState<FlowEntry[]>([]);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const refresh = () =>
    setEntries(
      cashFlows(
        SalesRepo.all(),
        PurchaseRepo.all(),
        ExpenseRepo.all(),
        PaymentRepo.all(),
        CashAdjustmentRepo.all(),
      ),
    );
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  // Balance is the true running cash-in-hand as of now — it doesn't change
  // when a date range is applied, only the period's In/Out totals do.
  const balance = entries.reduce((s, e) => s + e.in - e.out, 0);

  const dateFiltered = useMemo(() => {
    if (!dateFrom && !dateTo) return entries;
    return entries.filter(
      (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
    );
  }, [entries, dateFrom, dateTo]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return dateFiltered;
    return dateFiltered.filter((e) => [e.type, e.ref].some((v) => v.toLowerCase().includes(s)));
  }, [dateFiltered, q]);

  // Footer In/Out cover the filtered rows the table actually shows (date
  // range AND search) — `balance` above stays all-time by design.
  const totalIn = filtered.reduce((s, e) => s + e.in, 0);
  const totalOut = filtered.reduce((s, e) => s + e.out, 0);

  const pg = usePagination(filtered);

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Cash"
        subtitle={`${filtered.length} of ${entries.length} transactions`}
        icon={<Banknote className="h-5 w-5" />}
        mobileAction={
          <button
            onClick={() => setMobileFiltersOpen(true)}
            className="relative h-9 w-9 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50/60 text-gray-600"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {(dateFrom || dateTo) && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        }
        actions={
          <>
            {/* Date range — its own filter sheet on mobile (see Filters
                button above); this inline row is desktop only. */}
            <div className="hidden sm:flex items-center gap-1.5 h-9 pl-3 pr-2.5 rounded-lg border border-gray-200 bg-gray-50/60 shrink-0">
              <Calendar className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="bg-transparent text-xs text-gray-700 focus:outline-none w-[104px]"
              />
              <span className="text-gray-300 text-xs">–</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="bg-transparent text-xs text-gray-700 focus:outline-none w-[104px]"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-gray-400 hover:text-gray-600 transition"
                  title="Clear date range"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="relative w-full sm:w-56">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search type, reference…"
                className="w-full h-9 pl-9 pr-3 rounded-lg border border-gray-200 bg-gray-50/60 text-base md:text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-white transition"
              />
            </div>
            {editAllowed && (
              <Button size="sm" onClick={() => setAdjustOpen(true)} className="w-full sm:w-auto">
                <Banknote className="h-3.5 w-3.5" /> Adjust Cash
              </Button>
            )}
          </>
        }
      />

      {/* Mobile filter sheet — Date Range doesn't fit inline next to Search
          on a phone, so it lives here behind the header's Filters button
          instead, same state as the desktop inline control. */}
      <Dialog open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Date Range</label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="flex-1 h-9 px-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <span className="text-gray-300">–</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="flex-1 h-9 px-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="flex items-center justify-between pt-1">
              {dateFrom || dateTo ? (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600 transition flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              ) : (
                <span />
              )}
              <button
                onClick={() => setMobileFiltersOpen(false)}
                className="h-8 px-4 bg-primary text-primary-foreground rounded-md text-sm font-semibold hover:opacity-90 transition"
              >
                Done
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mobile card list — a table of 5 columns doesn't fit a phone; this is
          the same data as one row-card per transaction instead (read-only, same
          as the desktop table — no click action here either). */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Banknote className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No cash transactions yet</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((e, i) => (
              <div key={`${e.date}-${e.type}-${e.ref}-${e.in}-${e.out}-${i}`} className="bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-800 truncate">{e.type}</p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      {fmtDate(e.date)} · {e.ref}
                    </p>
                  </div>
                  <p className={`font-bold tabular-nums shrink-0 ${e.in ? "text-emerald-600" : e.out ? "text-rose-600" : "text-gray-800"}`}>
                    {e.in ? `+${fmtMoney(e.in)}` : e.out ? `−${fmtMoney(e.out)}` : "—"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          columns={[
            {
              key: "date",
              label: "Date",
              render: (e) => fmtDate(e.date),
              sortValue: (e) => e.date,
            },
            {
              key: "type",
              label: "Type",
              render: (e) => e.type,
              sortValue: (e) => e.type,
            },
            {
              key: "ref",
              label: "Reference",
              render: (e) => e.ref,
              sortValue: (e) => e.ref,
            },
            {
              key: "in",
              label: "Cash In",
              align: "right",
              render: (e) => <span className="tabular-nums">{e.in ? fmtMoney(e.in) : "—"}</span>,
              sortValue: (e) => e.in,
            },
            {
              key: "out",
              label: "Cash Out",
              align: "right",
              render: (e) => <span className="tabular-nums">{e.out ? fmtMoney(e.out) : "—"}</span>,
              sortValue: (e) => e.out,
            },
          ]}
          rows={filtered}
          rowKey={(e) => `${e.date}-${e.type}-${e.ref}-${e.in}-${e.out}`}
          emptyMessage={entries.length === 0 ? "No cash transactions yet" : "No matches for your search"}
          footer={
            <tr>
              <td colSpan={3}>
                Total <span className="text-gray-300">|</span>{" "}
                <span className="tabular-nums">{fmtMoney(balance)}</span>
              </td>
              <td className="text-right tabular-nums">{fmtMoney(totalIn)}</td>
              <td className="text-right tabular-nums">{fmtMoney(totalOut)}</td>
            </tr>
          }
        />
      </div>
      <CashAdjustDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        onSaved={refresh}
        currentBalance={balance}
      />
    </div>
  );
}

function CashAdjustDialog({
  open,
  onOpenChange,
  onSaved,
  currentBalance,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  currentBalance: number;
}) {
  const [type, setType] = useState<"add" | "reduce">("add");
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setType("add");
      setAmount(0);
      setDate(today());
      setReason("");
      setSaving(false);
    }
  }, [open]);

  const n = amount;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (n <= 0) {
      toast.error("Enter amount to adjust");
      return;
    }
    setSaving(true);
    CashAdjustmentRepo.add({ date, type, amount: n, reason: reason.trim() || undefined } as any);
    toast.success(`Cash ${type === "add" ? "added" : "reduced"}: ${fmtMoney(n)}`);
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust Cash on Hand</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Current balance:{" "}
            <span className="font-bold text-foreground">{fmtMoney(currentBalance)}</span>
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setType("add")}
              className={`flex-1 h-9 rounded-md border text-sm font-semibold transition ${type === "add" ? "bg-success-soft text-success border-success" : "bg-background text-muted-foreground"}`}
            >
              + Add Cash
            </button>
            <button
              type="button"
              onClick={() => setType("reduce")}
              className={`flex-1 h-9 rounded-md border text-sm font-semibold transition ${type === "reduce" ? "bg-destructive/10 text-destructive border-destructive" : "bg-background text-muted-foreground"}`}
            >
              − Reduce Cash
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <NumField label="Amount (₹) *" value={amount} onValue={setAmount} />
            <Field
              label="Date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <Field
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Opening cash, owner drawing, counting correction…"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Adjust Cash"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
