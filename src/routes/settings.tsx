import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { CompanyRepo, REPO_BY_KEY } from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { Field } from "@/components/Field";
import { NumField } from "@/components/NumInput";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { today } from "@/lib/format";
import { APP_VERSION } from "@/lib/version";
import { auth, isBrowser } from "@/lib/firebase";
import { usePermissions } from "@/hooks/usePermissions";
import { TeamSection } from "@/components/TeamSection";
import { WhatsAppSection } from "@/components/WhatsAppSection";
import type { Company } from "@/types";
import {
  Settings as SettingsIcon,
  Building2,
  Database,
  Keyboard,
  Download,
  Upload,
  Trash2,
  ShieldCheck,
  Receipt,
  X,
  Plus,
  Users2,
  MessageCircle,
} from "lucide-react";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  useRepoData();
  const [c, setC] = useState<Company>(() => CompanyRepo.get());
  const [busy, setBusy] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const userEmail = isBrowser ? (auth.currentUser?.email ?? "") : "";
  const { isOwner } = usePermissions();

  const companyRef = useRef<HTMLFormElement>(null);
  const categoriesRef = useRef<HTMLDivElement>(null);
  const teamRef = useRef<HTMLDivElement>(null);
  const whatsappRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<HTMLDivElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);

  const sections = [
    { key: "company", label: "Company Details", icon: Building2, ref: companyRef },
    { key: "categories", label: "Expense Categories", icon: Receipt, ref: categoriesRef },
    ...(isOwner ? [{ key: "team", label: "Team", icon: Users2, ref: teamRef }] : []),
    ...(isOwner ? [{ key: "whatsapp", label: "WhatsApp", icon: MessageCircle, ref: whatsappRef }] : []),
    { key: "data", label: "Account & Data", icon: Database, ref: dataRef },
    { key: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard, ref: shortcutsRef },
  ];
  const [activeSection, setActiveSection] = useState("company");

  useEffect(() => {
    const els = sections
      .map((s) => ({ key: s.key, el: s.ref.current }))
      .filter((s): s is { key: string; el: HTMLDivElement } => !!s.el);
    if (!els.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) {
          const top = visible.reduce((a, b) =>
            a.boundingClientRect.top < b.boundingClientRect.top ? a : b,
          );
          const match = els.find((s) => s.el === top.target);
          if (match) setActiveSection(match.key);
        }
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    els.forEach((s) => observer.observe(s.el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  // Category add/remove save immediately (like Export/Import below), rather
  // than waiting on the Company Details card's separate Save button, which
  // sits far enough away to feel disconnected from this action.
  const addCategory = () => {
    const name = newCategory.trim();
    if (!name) return;
    const existing = c.expenseCategories ?? [];
    if (existing.some((x) => x.toLowerCase() === name.toLowerCase())) {
      toast.error(`"${name}" is already in the list`);
      return;
    }
    const next = { ...c, expenseCategories: [...existing, name] };
    setC(next);
    CompanyRepo.save(next);
    setNewCategory("");
    toast.success(`"${name}" added`);
  };

  const removeCategory = (name: string) => {
    const next = { ...c, expenseCategories: (c.expenseCategories ?? []).filter((x) => x !== name) };
    setC(next);
    CompanyRepo.save(next);
    toast.success(`"${name}" removed`);
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    CompanyRepo.save(c);
    toast.success("Settings saved");
  };

  // Same file format as the old localStorage backups, so old backup files still restore
  const exportData = () => {
    const dump: Record<string, string> = {};
    for (const [key, repo] of Object.entries(REPO_BY_KEY)) {
      dump[key] = JSON.stringify(repo.all());
    }
    dump["bz.company"] = JSON.stringify(CompanyRepo.get());
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bizdesk-backup-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Backup downloaded");
  };

  // A hand-edited or old/partial backup can carry invoice/return line items
  // missing numeric fields (qty, price, discountPct, gstRate). Left as-is,
  // those turn every GST/report total that touches them into NaN. Coerce to
  // 0 at the import boundary so bad data can never enter the system.
  const sanitizeRecords = (records: any[]): any[] =>
    records.map((r) =>
      Array.isArray(r?.lineItems)
        ? {
          ...r,
          lineItems: r.lineItems.map((l: any) => ({
            ...l,
            qty: Number(l?.qty) || 0,
            price: Number(l?.price) || 0,
            discountPct: Number(l?.discountPct) || 0,
            gstRate: Number(l?.gstRate) || 0,
          })),
        }
        : r,
    );

  const importData = async (file: File) => {
    try {
      const dump = JSON.parse(await file.text());
      if (typeof dump !== "object" || dump === null) throw new Error("Invalid file");
      const known = Object.keys(REPO_BY_KEY).filter((k) => dump[k] != null);
      const hasCompany = dump["bz.company"] != null;
      if (!known.length && !hasCompany) {
        toast.error("No REEVANA X data found in this file");
        return;
      }
      if (
        !confirm(
          `Restore ${known.length + (hasCompany ? 1 : 0)} data sections from backup into the cloud? Records with the same ID will be overwritten.`,
        )
      )
        return;
      setBusy(true);
      for (const k of known) {
        const v = dump[k];
        const records = typeof v === "string" ? JSON.parse(v) : v;
        if (Array.isArray(records) && records.length) {
          await REPO_BY_KEY[k].importAll(sanitizeRecords(records));
        }
      }
      if (hasCompany) {
        const v = dump["bz.company"];
        CompanyRepo.save(typeof v === "string" ? JSON.parse(v) : v);
      }
      toast.success("Backup restored to cloud — reloading…");
      setTimeout(() => location.reload(), 800);
    } catch {
      setBusy(false);
      toast.error("Could not read backup file — is it a valid REEVANA X backup?");
    }
  };

  const clearAll = async () => {
    if (!confirm("Delete ALL business data from the cloud? This cannot be undone.")) return;
    if (
      !confirm(
        "Are you really sure? Every invoice, party, item and payment will be permanently deleted.",
      )
    )
      return;
    setBusy(true);
    try {
      for (const repo of Object.values(REPO_BY_KEY)) {
        await repo.clearAll();
      }
      toast.success("All data cleared");
      setTimeout(() => location.reload(), 600);
    } catch {
      setBusy(false);
      toast.error("Could not clear all data — check your connection");
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Settings"
        subtitle="Company & preferences"
        icon={<SettingsIcon className="h-5 w-5" />}
      />
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <nav className="w-56 shrink-0 border-r border-gray-100 bg-white/60 py-6 px-3 hidden md:block overflow-y-auto">
          <ul className="space-y-0.5">
            {sections.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() =>
                    s.ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium transition text-left ${activeSection === s.key
                      ? "bg-primary-soft text-primary"
                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                    }`}
                >
                  <s.icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="p-4 sm:p-6 space-y-4 max-w-3xl mx-auto">
            <form
              ref={companyRef}
              onSubmit={save}
              className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
            >
              <SectionHeader
                icon={<Building2 className="h-4 w-4" />}
                title="Company Details"
                description="Shown on every invoice, bill, and printed document"
              />
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Field
                    label="Company Name *"
                    value={c.name}
                    onChange={(e) => setC({ ...c, name: e.target.value })}
                  />
                </div>
                <Field
                  label="GSTIN"
                  value={c.gstin ?? ""}
                  onChange={(e) => setC({ ...c, gstin: e.target.value.toUpperCase() })}
                />
                <Field
                  label="Phone"
                  value={c.phone ?? ""}
                  onChange={(e) => setC({ ...c, phone: e.target.value })}
                />
                <Field
                  label="Email"
                  value={c.email ?? ""}
                  onChange={(e) => setC({ ...c, email: e.target.value })}
                />
                <Field
                  label="Currency"
                  value={c.currency}
                  onChange={(e) => setC({ ...c, currency: e.target.value.toUpperCase() })}
                />
                <Field
                  label="Invoice Prefix"
                  value={c.invoicePrefix}
                  onChange={(e) => setC({ ...c, invoicePrefix: e.target.value })}
                />
                <Field
                  label="Purchase Prefix"
                  value={c.purchasePrefix}
                  onChange={(e) => setC({ ...c, purchasePrefix: e.target.value })}
                />
                <div className="sm:col-span-2">
                  <Field
                    label="Address"
                    value={c.address ?? ""}
                    onChange={(e) => setC({ ...c, address: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2 space-y-2 pt-1">
                  <ToggleRow
                    checked={c.enableRoundOff !== false}
                    onChange={(v) => setC({ ...c, enableRoundOff: v })}
                    label="Round off invoice totals to nearest rupee"
                    hint="e.g. ₹487.37 → ₹487"
                  />
                  <ToggleRow
                    checked={c.allowNegativeStock !== false}
                    onChange={(v) => setC({ ...c, allowNegativeStock: v })}
                    label="Allow selling below available stock"
                    hint="Turn off to block sales/returns that would take stock negative"
                  />
                  <ToggleRow
                    checked={c.referralEnabled === true}
                    onChange={(v) => setC({ ...c, referralEnabled: v })}
                    label="Enable referral commission"
                    hint="A sale for a party with a referrer credits both of them a wallet commission"
                  />
                </div>
                {c.referralEnabled && (
                  <>
                    <NumField
                      label="Referral Commission %"
                      value={c.referralPercent ?? 10}
                      onValue={(n) => setC({ ...c, referralPercent: n })}
                    />
                    <NumField
                      label="Referral Cap Per Bill (₹)"
                      value={c.referralMaxPerBill ?? 500}
                      onValue={(n) => setC({ ...c, referralMaxPerBill: n })}
                    />
                  </>
                )}
              </div>
              <div className="px-5 py-3 border-t bg-gray-50/60 flex justify-end">
                <Button type="submit">Save</Button>
              </div>
            </form>

            <div
              ref={categoriesRef}
              className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
            >
              <SectionHeader
                icon={<Receipt className="h-4 w-4" />}
                title="Expense Categories"
                description="The only categories staff can pick when recording an expense — add or remove them here, like a Chart of Accounts"
              />
              <div className="p-5">
                <div className="flex flex-wrap gap-2 mb-4">
                  {(c.expenseCategories ?? []).length === 0 && (
                    <p className="text-xs text-gray-400">No categories yet — add one below.</p>
                  )}
                  {(c.expenseCategories ?? []).map((cat) => (
                    <span
                      key={cat}
                      className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-full bg-primary-soft text-primary text-xs font-semibold"
                    >
                      {cat}
                      <button
                        type="button"
                        onClick={() => removeCategory(cat)}
                        className="rounded-full p-0.5 hover:bg-primary/20 transition"
                        title={`Remove "${cat}"`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCategory();
                      }
                    }}
                    placeholder="e.g. Marketing, Insurance…"
                    className="h-9 px-3 border rounded-md bg-background text-sm flex-1 focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none"
                  />
                  <Button type="button" onClick={addCategory}>
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </div>
              </div>
            </div>

            {isOwner && (
              <div
                ref={teamRef}
                className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
              >
                <SectionHeader
                  icon={<Users2 className="h-4 w-4" />}
                  title="Team"
                  description="Give staff their own login with only the sections they need — never a configurable permission for this Team page itself, so no one can grant themselves broader access"
                />
                <div className="p-5">
                  <TeamSection />
                </div>
              </div>
            )}

            {isOwner && (
              <div
                ref={whatsappRef}
                className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
              >
                <SectionHeader
                  icon={<MessageCircle className="h-4 w-4" />}
                  title="WhatsApp"
                  description="Send bills and party ledgers straight to a customer's WhatsApp with one click, from your own shop number"
                />
                <div className="p-5">
                  <WhatsAppSection />
                </div>
              </div>
            )}

            <div
              ref={dataRef}
              className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
            >
              <SectionHeader
                icon={<Database className="h-4 w-4" />}
                title="Account & Data"
                description="Backups, restore, and cloud sync status"
              />
              <div className="p-5">
                {userEmail && (
                  <div className="flex items-start gap-2 text-xs text-gray-500 mb-4 bg-emerald-50/60 border border-emerald-100 rounded-md px-3 py-2.5">
                    <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                    <p>
                      Signed in as <span className="font-semibold text-gray-800">{userEmail}</span>{" "}
                      · Data is stored securely in the cloud (Firebase) and works offline too. · App
                      version: {APP_VERSION}
                    </p>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-2 sm:flex-wrap">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={exportData}
                    className="w-full sm:w-auto"
                  >
                    <Download className="h-3.5 w-3.5" /> Export Backup (JSON)
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => importRef.current?.click()}
                    className="w-full sm:w-auto"
                  >
                    <Upload className="h-3.5 w-3.5" /> Import Backup
                  </Button>
                  <input
                    ref={importRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) importData(file);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={clearAll}
                    className="w-full sm:w-auto"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Clear All Data
                  </Button>
                </div>
                <p className="text-xs text-gray-400 mt-3">
                  Backups download as JSON files. Old backups from the localStorage version restore
                  fine too.
                </p>
              </div>
            </div>

            <div
              ref={shortcutsRef}
              className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
            >
              <SectionHeader icon={<Keyboard className="h-4 w-4" />} title="Keyboard Shortcuts" />
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                {[
                  ["Ctrl+F", "Global search"],
                  ["Ctrl+N", "New sale"],
                  ["Ctrl+P", "New purchase"],
                  ["Ctrl+S", "Save form"],
                  ["Alt+1..8", "Jump to module"],
                  ["N", "New record (in list)"],
                  ["Tab / Enter", "Next field"],
                  ["Shift+Tab", "Previous field"],
                  ["Esc", "Close dialog / cancel"],
                  ["↑ ↓", "Navigate rows / suggestions"],
                  ["Enter", "Open / select"],
                  ["Ctrl+Delete", "Delete row"],
                ].map(([k, l]) => (
                  <div
                    key={k}
                    className="flex items-center justify-between border-b border-gray-100 py-1.5"
                  >
                    <kbd className="font-mono text-[11px] bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                      {k}
                    </kbd>
                    <span className="text-gray-500">{l}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-3">
      <div className="h-8 w-8 rounded-md bg-primary-soft text-primary flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <h2 className="font-bold text-[14px] text-gray-800">{title}</h2>
        {description && <p className="text-[11px] text-gray-400 mt-0.5">{description}</p>}
      </div>
    </div>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border border-gray-100 bg-gray-50/60 px-3 py-2.5 cursor-pointer select-none hover:bg-gray-50 transition">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary mt-0.5 shrink-0"
      />
      <span>
        <span className="block text-[13px] font-medium text-gray-800">{label}</span>
        <span className="block text-[11px] text-gray-400 mt-0.5">{hint}</span>
      </span>
    </label>
  );
}
