export const fmtMoney = (n: number, currency = "INR") => {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n || 0);
  } catch {
    return `₹${(n || 0).toFixed(2)}`;
  }
};

export const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
};

/** Local-timezone YYYY-MM-DD (toISOString is UTC and gives yesterday's date
 * before 5:30 AM in India — never use it for business dates). */
export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const today = () => ymd(new Date());

/** "14:05" -> "2:05 PM" */
export const fmtTime = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
};

/** ISO timestamp -> "Reminded 2h ago" — shared by the Appointments list and
 * a party's own "Upcoming Appointments" card, so a staff member doesn't
 * re-send the same reminder minutes apart from two different screens. */
export const fmtSince = (iso: string, prefix = "Reminded") => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${prefix} ${mins || 1}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${prefix} ${hrs}h ago`;
  return `${prefix} ${Math.round(hrs / 24)}d ago`;
};
