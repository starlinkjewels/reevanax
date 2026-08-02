import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/components/Pagination";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import { AppointmentRepo, PartyRepo } from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import type { Appointment, AppointmentStatus, Party } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { fmtDate, fmtTime, fmtSince, today } from "@/lib/format";
import { sendTextViaWhatsApp } from "@/lib/whatsappSend";
import {
  Plus,
  Search,
  Pencil,
  CalendarClock,
  Check,
  X as XIcon,
  Trash2,
  MessageCircle,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/appointments")({
  component: AppointmentsPage,
  // Set only by the "Book Appointment" link on a party's own page — carries
  // that party straight into a fresh booking instead of making staff search
  // for them again right after they were already looking at that client.
  validateSearch: (search: Record<string, unknown>): { bookFor?: string } => ({
    bookFor: typeof search.bookFor === "string" ? search.bookFor : undefined,
  }),
});

type ViewFilter = "upcoming" | "completed" | "cancelled" | "all";

const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const reminderLabel = (a: Appointment): string | null => (a.reminderSentAt ? fmtSince(a.reminderSentAt) : null);

function AppointmentsPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("appointments");
  const deleteAllowed = isOwner || canDelete("appointments");
  const { bookFor } = Route.useSearch();

  const [rows, setRows] = useState<Appointment[]>([]);
  const [q, setQ] = useState("");
  const [view, setView] = useState<ViewFilter>("upcoming");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Appointment | null>(null);
  const [presetPartyId, setPresetPartyId] = useState<string | undefined>(undefined);
  const [remindingId, setRemindingId] = useState<string | null>(null);

  const refresh = () => setRows(AppointmentRepo.all());
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  // Deep link from a party's page ("Book Appointment") — open straight into
  // a fresh booking preselected to that party, then drop the param so
  // reloading/revisiting this page later doesn't keep reopening the dialog.
  useEffect(() => {
    if (!bookFor) return;
    setEdit(null);
    setPresetPartyId(bookFor);
    setOpen(true);
    navigate({ to: "/appointments", search: {}, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookFor]);

  const nDate = today();
  const nTime = nowTime();
  const isPastSlot = (a: Appointment) => a.date < nDate || (a.date === nDate && a.time < nTime);

  const filtered = rows
    .filter((r) => {
      if (view === "upcoming") return r.status === "booked";
      if (view === "completed") return r.status === "completed";
      if (view === "cancelled") return r.status === "cancelled";
      return true;
    })
    .filter((r) => {
      const s = q.trim().toLowerCase();
      return !s || r.partyName.toLowerCase().includes(s) || (r.partyPhone ?? "").includes(s);
    })
    .sort((a, b) => {
      // Upcoming reads soonest-first (what's due next); every other view
      // reads most-recent-first, matching every other list in this app.
      if (view === "upcoming") {
        return a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date);
      }
      return a.date === b.date ? b.time.localeCompare(a.time) : b.date.localeCompare(a.date);
    });

  const upcomingCount = rows.filter((r) => r.status === "booked").length;
  const completedCount = rows.filter((r) => r.status === "completed").length;
  const cancelledCount = rows.filter((r) => r.status === "cancelled").length;

  const pg = usePagination(filtered);

  const setStatus = (r: Appointment, status: AppointmentStatus) => {
    AppointmentRepo.update(r.id, { status });
    refresh();
    toast.success(
      status === "completed"
        ? `Marked ${r.partyName}'s appointment complete`
        : `Cancelled ${r.partyName}'s appointment — that slot is free again`,
    );
  };

  const remove = (r: Appointment) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete appointments");
      return;
    }
    if (confirm(`Delete ${r.partyName}'s appointment on ${fmtDate(r.date)}? This can't be undone.`)) {
      AppointmentRepo.remove(r.id);
      refresh();
      toast.success("Appointment deleted");
    }
  };

  const remind = async (r: Appointment) => {
    if (!r.partyPhone?.trim()) {
      toast.error("This party has no phone number saved — add one on their party record first.");
      return;
    }
    setRemindingId(r.id);
    try {
      await sendTextViaWhatsApp({
        phone: r.partyPhone,
        message: `Hi ${r.partyName}, this is a reminder for your appointment on ${fmtDate(r.date)} at ${fmtTime(r.time)}.`,
      });
      AppointmentRepo.update(r.id, { reminderSentAt: new Date().toISOString() });
      refresh();
      toast.success(`Reminder sent to ${r.partyName}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send reminder");
    } finally {
      setRemindingId(null);
    }
  };

  const columns: Column<Appointment>[] = [
    {
      key: "date",
      label: "Date",
      width: "110px",
      render: (r) => fmtDate(r.date),
      sortValue: (r) => r.date,
    },
    {
      key: "time",
      label: "Time",
      width: "90px",
      render: (r) => fmtTime(r.time),
      sortValue: (r) => r.time,
    },
    {
      key: "client",
      label: "Client",
      render: (r) => (
        <div>
          <div className="font-medium">{r.partyName}</div>
          {r.partyPhone && <div className="text-[11px] text-muted-foreground">{r.partyPhone}</div>}
        </div>
      ),
      sortValue: (r) => r.partyName,
    },
    { key: "notes", label: "Notes", render: (r) => r.notes || "—" },
    {
      key: "status",
      label: "Status",
      width: "110px",
      render: (r) => (
        <span
          className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border ${
            r.status === "booked"
              ? isPastSlot(r)
                ? "text-amber-600 bg-amber-50 border-amber-200"
                : "text-emerald-600 bg-emerald-50 border-emerald-200"
              : r.status === "completed"
                ? "text-blue-600 bg-blue-50 border-blue-200"
                : "text-gray-500 bg-gray-100 border-gray-200"
          }`}
        >
          {r.status === "booked" && isPastSlot(r) ? "Overdue" : r.status}
        </span>
      ),
    },
    {
      key: "reminder",
      label: "Reminder",
      width: "150px",
      render: (r) =>
        r.status !== "booked" ? (
          "—"
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              remind(r);
            }}
            disabled={remindingId === r.id}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
            title={r.partyPhone ? "Send WhatsApp reminder" : "No phone number saved"}
          >
            {remindingId === r.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageCircle className="h-3.5 w-3.5" />
            )}
            {reminderLabel(r) ?? "Send Reminder"}
          </button>
        ),
    },
    {
      key: "actions",
      label: "Action",
      width: "110px",
      align: "center",
      render: (r) => (
        <span className="inline-flex gap-1">
          {editAllowed && r.status === "booked" && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEdit(r);
                  setOpen(true);
                }}
                className="p-1 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                title="Edit appointment"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setStatus(r, "completed");
                }}
                className="p-1 rounded hover:bg-emerald-50 text-gray-400 hover:text-emerald-600 transition"
                title="Mark completed"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setStatus(r, "cancelled");
                }}
                className="p-1 rounded hover:bg-amber-50 text-gray-400 hover:text-amber-600 transition"
                title="Cancel appointment"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {deleteAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                remove(r);
              }}
              className="p-1 rounded hover:bg-rose-50 text-gray-400 hover:text-rose-600 transition"
              title="Delete appointment"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
  ];

  const viewToggleButtons = (
    <>
      <button
        onClick={() => setView("upcoming")}
        className={`h-8 px-3 text-xs font-semibold transition ${view === "upcoming" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
      >
        Upcoming ({upcomingCount})
      </button>
      <button
        onClick={() => setView("completed")}
        className={`h-8 px-3 text-xs font-semibold transition ${view === "completed" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
      >
        Completed ({completedCount})
      </button>
      <button
        onClick={() => setView("cancelled")}
        className={`h-8 px-3 text-xs font-semibold transition ${view === "cancelled" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
      >
        Cancelled ({cancelledCount})
      </button>
      <button
        onClick={() => setView("all")}
        className={`h-8 px-3 text-xs font-semibold transition ${view === "all" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
      >
        All ({rows.length})
      </button>
    </>
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Appointments"
        subtitle={`${upcomingCount} upcoming · ${rows.length} total`}
        icon={<CalendarClock className="h-5 w-5" />}
        mobileAction={
          <div className="inline-flex rounded-md border border-gray-200 bg-white overflow-hidden shrink-0">
            {viewToggleButtons}
          </div>
        }
        actions={
          <>
            <div className="hidden sm:inline-flex rounded-md border border-gray-200 bg-white overflow-hidden shrink-0">
              {viewToggleButtons}
            </div>
            <div className="relative w-full sm:w-44 lg:w-56">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                placeholder="Search client..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full h-8 pl-8 pr-3 border border-gray-200 rounded-md text-base md:text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
            </div>
            {editAllowed && (
              <Button
                size="sm"
                onClick={() => {
                  setEdit(null);
                  setPresetPartyId(undefined);
                  setOpen(true);
                }}
                className="w-full sm:w-auto"
              >
                <Plus className="h-3.5 w-3.5" /> New Appointment
              </Button>
            )}
          </>
        }
      />

      {/* Mobile card list */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <CalendarClock className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No appointments found</p>
            <p className="text-xs mt-1">Try a different filter or book a new appointment</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => (
              <div key={r.id} className="bg-white p-4">
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-800 truncate">{r.partyName}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {fmtDate(r.date)} · {fmtTime(r.time)}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border shrink-0 ${
                      r.status === "booked"
                        ? isPastSlot(r)
                          ? "text-amber-600 bg-amber-50 border-amber-200"
                          : "text-emerald-600 bg-emerald-50 border-emerald-200"
                        : r.status === "completed"
                          ? "text-blue-600 bg-blue-50 border-blue-200"
                          : "text-gray-500 bg-gray-100 border-gray-200"
                    }`}
                  >
                    {r.status === "booked" && isPastSlot(r) ? "Overdue" : r.status}
                  </span>
                </div>
                {r.notes && <p className="text-xs text-gray-500 mb-2">{r.notes}</p>}
                <div className="flex items-center justify-between gap-2">
                  {r.status === "booked" ? (
                    <button
                      onClick={() => remind(r)}
                      disabled={remindingId === r.id}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-600 disabled:opacity-50"
                    >
                      {remindingId === r.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <MessageCircle className="h-3.5 w-3.5" />
                      )}
                      {reminderLabel(r) ?? "Send Reminder"}
                    </button>
                  ) : (
                    <span />
                  )}
                  <div className="flex items-center gap-1">
                    {editAllowed && r.status === "booked" && (
                      <>
                        <button
                          onClick={() => {
                            setEdit(r);
                            setOpen(true);
                          }}
                          className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setStatus(r, "completed")}
                          className="p-1.5 rounded hover:bg-emerald-50 text-gray-400 hover:text-emerald-600 transition"
                          title="Mark completed"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setStatus(r, "cancelled")}
                          className="p-1.5 rounded hover:bg-amber-50 text-gray-400 hover:text-amber-600 transition"
                          title="Cancel"
                        >
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                    {deleteAllowed && (
                      <button
                        onClick={() => remove(r)}
                        className="p-1.5 rounded hover:bg-rose-50 text-gray-400 hover:text-rose-600 transition"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Table (desktop) */}
      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable columns={columns} rows={filtered} rowKey={(r) => r.id} />
      </div>

      <AppointmentDialog
        open={open}
        onOpenChange={setOpen}
        appt={edit}
        presetPartyId={presetPartyId}
        onSaved={refresh}
      />
    </div>
  );
}

function AppointmentDialog({
  open,
  onOpenChange,
  appt,
  presetPartyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appt: Appointment | null;
  presetPartyId?: string;
  onSaved: () => void;
}) {
  const firstRef = useRef<HTMLInputElement>(null);
  const [selectedParty, setSelectedParty] = useState<Party | null>(null);
  const [partyQ, setPartyQ] = useState("");
  const [partyOpen, setPartyOpen] = useState(false);
  const [date, setDate] = useState(today());
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (appt) {
      const party = PartyRepo.get(appt.partyId);
      setSelectedParty(
        party ?? {
          id: appt.partyId,
          name: appt.partyName,
          phone: appt.partyPhone,
          type: "both",
          openingBalance: 0,
          createdAt: "",
        },
      );
      setPartyQ(appt.partyName);
      setDate(appt.date);
      setTime(appt.time);
      setNotes(appt.notes ?? "");
    } else {
      const preset = presetPartyId ? PartyRepo.get(presetPartyId) : undefined;
      setSelectedParty(preset ?? null);
      setPartyQ(preset?.name ?? "");
      setDate(today());
      setTime("");
      setNotes("");
    }
    setPartyOpen(false);
    setSaving(false);
    setTimeout(() => firstRef.current?.focus(), 50);
  }, [open, appt, presetPartyId]);

  const partyQTrim = partyQ.trim().toLowerCase();
  const partySuggests = (
    partyQTrim
      ? PartyRepo.all().filter((p) => !p.archived && p.name.trim().toLowerCase().includes(partyQTrim))
      : PartyRepo.all().filter((p) => !p.archived)
  ).slice(0, 8);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!selectedParty) {
      toast.error("Select a client");
      return;
    }
    if (!date) {
      toast.error("Date is required");
      return;
    }
    if (!time) {
      toast.error("Time is required");
      return;
    }
    // Single-resource booking: only one non-cancelled appointment can exist
    // at any exact date+time, across the whole business.
    const clash = AppointmentRepo.all().find(
      (a) => a.date === date && a.time === time && a.status !== "cancelled" && a.id !== appt?.id,
    );
    if (clash) {
      toast.error(`${fmtTime(time)} on ${fmtDate(date)} is already booked for ${clash.partyName}`);
      return;
    }
    setSaving(true);
    if (appt) {
      AppointmentRepo.update(appt.id, {
        partyId: selectedParty.id,
        partyName: selectedParty.name,
        partyPhone: selectedParty.phone,
        date,
        time,
        notes: notes.trim() || undefined,
      });
      toast.success("Appointment updated");
    } else {
      AppointmentRepo.add({
        partyId: selectedParty.id,
        partyName: selectedParty.name,
        partyPhone: selectedParty.phone,
        date,
        time,
        notes: notes.trim() || undefined,
        status: "booked",
      } as any);
      toast.success(`Appointment booked for ${selectedParty.name}`);
    }
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{appt ? "Edit Appointment" : "New Appointment"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="relative sm:col-span-2">
            <span className="text-muted-foreground font-medium text-[12px]">Client *</span>
            <input
              ref={firstRef}
              value={partyQ}
              onChange={(e) => {
                setPartyQ(e.target.value);
                setSelectedParty(null);
                setPartyOpen(true);
              }}
              onFocus={() => setPartyOpen(true)}
              onBlur={() => setTimeout(() => setPartyOpen(false), 150)}
              placeholder="Search a client by name"
              autoComplete="off"
              className="mt-1 w-full h-9 px-3 border rounded-md bg-background text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            {partyOpen && partySuggests.length > 0 && (
              <div className="absolute z-30 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-52 overflow-auto">
                {partySuggests.map((p) => (
                  <div
                    key={p.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setSelectedParty(p);
                      setPartyQ(p.name);
                      setPartyOpen(false);
                    }}
                    className="px-3 py-2 text-sm cursor-pointer hover:bg-accent flex items-center justify-between"
                  >
                    <span className="font-medium">{p.name}</span>
                    {p.phone && <span className="text-[11px] text-muted-foreground">{p.phone}</span>}
                  </div>
                ))}
              </div>
            )}
            {selectedParty && !selectedParty.phone && (
              <p className="text-[11px] text-amber-600 mt-1">
                No phone saved for {selectedParty.name} — reminders won't be sendable until one is added.
              </p>
            )}
          </div>
          <Field
            label="Date *"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Field
            label="Time *"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          <label className="sm:col-span-2 flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="What's this appointment for (optional)"
              className="px-2 py-1.5 border rounded bg-background outline-none focus:border-primary focus:ring-1 focus:ring-primary resize-y"
            />
          </label>
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
