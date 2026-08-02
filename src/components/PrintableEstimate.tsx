import type { Invoice, Company } from "@/types";
import { fmtMode } from "@/components/ModePills";
import { PartyRepo } from "@/repositories";

/**
 * The shop's own bill layout (the printed format the client supplied), used by
 * the "2 Copies" print option — two of these side by side on one landscape A4.
 *
 * Deliberately NOT a variant of PrintableInvoice: that one is a GST tax
 * invoice (Unit / Disc% / GST% / GST Amt columns, tax summary, terms), while
 * this is the counter bill — Sr / Particulars / Code / QTY / Rate / Amount,
 * a party-ledger balance block, and two signature lines. Keeping them
 * separate means the A4 / 80mm / 58mm formats are completely untouched by
 * anything done here.
 *
 * The whole sheet is one outer table with a fixed pixel `height` and the
 * items row set to `height: 100%`. That is what makes the item grid stretch
 * to the bottom of the paper ("full page proper use") instead of leaving the
 * lower half of the sheet blank — and it's done with table row heights rather
 * than flexbox because Chrome's print/PDF pass distributes leftover table
 * height identically on screen and on paper, which flex `min-height: 0`
 * chains do not.
 */
interface Props {
  inv: Invoice;
  company: Company;
  mode: "sale" | "purchase";
  /** The party's saved address (Parties → Address). Blank is fine — the
   * line is simply not printed. */
  partyAddress?: string;
  /** Item code (Item → SKU) keyed by LineItem.id. Resolved by the caller so
   * this component never reads a repository itself. */
  codeByLine?: Record<string, string>;
  /**
   * The party's ledger balance immediately BEFORE this bill, and immediately
   * after it. Both left undefined when the signed-in user's permissions mean
   * the full ledger (sales + purchases + returns + payments) can't be read —
   * the block is then hidden rather than printed with a wrong number.
   */
  previousBalance?: number;
  closingBalance?: number;
  /** Exact height of one copy in px — see the note above about stretching. */
  height?: number;
  className?: string;
}

const BORDER = "1px solid #000";
const ROW_RULE = "1px dotted #999";
/**
 * Smallest the item rows may shrink to in order to hold one page.
 *
 * Set low on purpose. This app's print CSS positions the printed sheet
 * absolutely (see `.print-visible` in styles.css, shared by every format), and
 * absolutely positioned content does not paginate — Chrome renders page one
 * and DROPS whatever sits past the page edge. So overflowing isn't a tidy
 * "continues overleaf", it silently cuts off the signature strip. Shrinking a
 * little further than is comfortable to read always beats losing the bottom of
 * the bill; a realistic counter bill never gets anywhere near this floor.
 */
const MIN_ROW_FONT = 4.5;

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0);

/** 25 → "25", 2.5 → "2.5" — quantities are counts here, not money. */
const qty = (n: number) => String(Math.round((n + Number.EPSILON) * 1000) / 1000);

/** dd/MM/yyyy, matching the supplied bill (fmtDate's "18 Jul 2026" is the
 * app's on-screen style, not this printed one). */
const dmy = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

export function PrintableEstimate({
  inv,
  company,
  mode,
  partyAddress,
  codeByLine,
  previousBalance,
  closingBalance,
  height = 745,
  className = "",
}: Props) {
  const gstOn = inv.gstEnabled !== false;
  const isSale = mode === "sale";
  // Identical wording to the A4 invoice, so the same bill never announces
  // itself as two different documents depending on the format chosen.
  // "Tax Invoice" is kept when GST applies (required wording); the plain-sale
  // label is dropped since the logo already carries the company name.
  const title = gstOn ? "TAX INVOICE" : isSale ? "" : "PURCHASE BILL";

  // Same arithmetic as PrintableInvoice, so the two formats can never print
  // different numbers for the same bill.
  let taxableTotal = 0;
  let lineAmountTotal = 0;
  const lines = inv.lineItems.map((l) => {
    const taxable = l.qty * l.price * (1 - l.discountPct / 100);
    const gstAmt = gstOn ? taxable * (l.gstRate / 100) : 0;
    taxableTotal += taxable;
    lineAmountTotal += taxable + gstAmt;
    return { l, amount: taxable + gstAmt };
  });
  const totalQty = inv.lineItems.reduce((s, l) => s + l.qty, 0);

  // The bill is only ever shown as part of a party's running account when the
  // caller could compute both ends of it.
  const showBalances = previousBalance !== undefined && closingBalance !== undefined;
  // Money taken at the counter against this bill. Shown whenever it's
  // non-zero, otherwise "Previous + New = Closing" wouldn't add up on paper.
  const paidNow = inv.paid || 0;

  // ── Fit the item grid onto one sheet ──────────────────────────────────
  // Item rows shrink as the bill gets longer, so a big order still prints on
  // ONE page instead of pushing a stray second sheet out of the printer.
  //
  // Shrinking has to account for wrapping, not just the row count: a long
  // item name that spills onto a second text line costs almost twice the
  // height, and shrinking the font is exactly what pulls it back onto one
  // line — so a smaller font can save far more than its own size. That
  // feedback is why this is a search for the largest font that fits rather
  // than a division.
  //
  // Both models below are deliberate over-estimates, calibrated against real
  // renders in headless Chrome (the same engine behind the on-screen preview
  // AND the exported PDF): AVAIL leaves ~16px more page chrome than measured,
  // the per-row cost allows a 1.45em line box against a real ~1.2em, and
  // CHARS_PER_LINE assumes wider characters than Arial actually draws. Every
  // one of them errs toward "shrink a little sooner", because text a point
  // smaller than necessary is invisible to the client while a bill that
  // silently spills onto page two is not.
  //
  // See MIN_ROW_FONT for why the floor is set as low as it is.
  //
  // The space the grid gets is what's left after everything else on the
  // sheet, and that is NOT a constant — a GSTIN line, a two-line party
  // address, and the CGST/SGST/Discount/Shipping/Round-off rows each add real
  // height. A single hard-coded figure silently under-counted them and long
  // bills spilled to a second page, so the chrome is counted from the content
  // actually being printed. Line heights here are the measured ones (~13px
  // for a 10px line, ~17px for a table row), each rounded up.
  const headerLines =
    2 + // document title + company name (the name is ~25px, counted below)
    (company.address ? 1 : 0) +
    (company.phone || company.email ? 1 : 0) +
    (gstOn && company.gstin ? 1 : 0);
  const partyLines = 2 + (partyAddress ? partyAddress.split("\n").length : 0);
  const metaRows = 3; // Estimate No. / Date / Payment
  const balanceRows = (showBalances ? 2 : 0) + 1 + (paidNow > 0 ? 1 : 0);
  const totalRows =
    (gstOn && inv.taxAmount > 0 ? 3 : 0) + // Taxable / CGST / SGST
    (inv.discount > 0 ? 1 : 0) +
    (inv.shippingCharge ? 1 : 0) +
    (inv.roundOff && Math.abs(inv.roundOff) > 0.001 ? 1 : 0) +
    1; // TOTAL
  // Measured in headless Chrome: 316px for the plainest bill, 346px once the
  // GST rows appear. The figures below reproduce that and then some — every
  // one is rounded up, so the estimate always claims LESS room for the grid
  // than really exists (~25px spare on the shapes measured).
  const CHROME =
    120 + // header block: title, 20px company name, address, phone, padding, rule
    13 * Math.max(0, headerLines - 4) + // a GSTIN line on top of the usual four
    18 * Math.max(partyLines, metaRows) + // party block and meta box sit side by side
    20 + // column headings
    20 + // Sub-Total row
    26 * Math.max(balanceRows, totalRows) + // balance block and totals sit side by side
    50; // "For <company>" + the two signature lines
  const AVAIL = Math.max(120, height - CHROME);
  // Particulars column: 38% of a ~523px copy, less cell padding and borders,
  // then 92% of that because nothing ever splits mid-word — a name is pushed
  // to a second line by its last whole word, well before the column is full.
  //
  // 0.75em per character sits well above the 0.62em Arial actually measures
  // for the UPPERCASE names this shop uses (mixed case is nearer 0.47em).
  // Both looser figures were tried and both still predicted single lines that
  // Chrome went on to wrap, and that is the one error that matters here:
  // under-estimating a wrap costs a whole extra line on every affected row.
  const PARTICULARS_PX = 187 * 0.92;
  const EM_PER_CHAR = 0.75;
  // A row measures 0.6em of padding plus ~1.6em per line of text — measured
  // across font sizes 6 → 10 in headless Chrome (18px, 22px and 38px rows all
  // land on it). 1.7em is used instead of 1.6 to keep erring high.
  const gridHeightAt = (font: number) => {
    const cap = Math.max(8, PARTICULARS_PX / (EM_PER_CHAR * font));
    let total = 0;
    for (const { l } of lines) {
      const chars = l.name.length + (l.discountPct > 0 ? 12 : 0);
      total += 0.6 * font + 1.7 * font * Math.max(1, Math.ceil(chars / cap));
    }
    return total;
  };
  let rowFont = 10;
  if (gridHeightAt(rowFont) > AVAIL) {
    let lo = MIN_ROW_FONT;
    let hi = 10;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (gridHeightAt(mid) <= AVAIL) lo = mid;
      else hi = mid;
    }
    rowFont = lo;
  }
  const rowPad = rowFont * 0.3;

  const cell: React.CSSProperties = { padding: "3px 5px", fontSize: 10 };
  // No background fill anywhere on this bill, on purpose. Chrome's print
  // dialog has "Background graphics" OFF by default, so any shaded row is
  // simply dropped on paper while still showing on screen — the printout
  // then can't match the preview no matter what we do here. Borders always
  // print. The supplied bill has white header rows anyway.
  const th: React.CSSProperties = {
    ...cell,
    border: BORDER,
    fontWeight: 700,
    fontSize: 10,
    textAlign: "center",
  };
  const body: React.CSSProperties = {
    padding: `${rowPad}px 5px`,
    fontSize: rowFont,
    borderLeft: BORDER,
    borderRight: BORDER,
    borderBottom: ROW_RULE,
    verticalAlign: "top",
  };
  const filler: React.CSSProperties = { borderLeft: BORDER, borderRight: BORDER };
  const foot: React.CSSProperties = {
    ...cell,
    border: BORDER,
    borderTop: BORDER,
    fontWeight: 700,
  };
  /** label:value pair used by both the meta box and the totals block */
  const label: React.CSSProperties = { ...cell, whiteSpace: "nowrap" };

  const totalsRow = (text: string, value: string, strong = false) => (
    <tr style={strong ? { fontWeight: 800 } : undefined}>
      <td style={{ ...label, fontWeight: strong ? 800 : 600 }}>{text}</td>
      <td style={{ ...cell, textAlign: "right", fontSize: strong ? 12 : 10 }}>{value}</td>
    </tr>
  );

  return (
    <div className={className} style={{ fontFamily: "Arial, sans-serif", color: "#000" }}>
      <table
        style={{
          width: "100%",
          height,
          borderCollapse: "collapse",
          border: BORDER,
          tableLayout: "fixed",
        }}
      >
        <tbody>
          {/* ── Company header ─────────────────────────────────────────────
              Same block as the A4 invoice (PrintableInvoice) — document
              title, company name, address, phone/email, GSTIN — all centred,
              so the two formats introduce the business identically and the
              title line is never missing from this one. */}
          <tr>
            <td style={{ padding: 0, verticalAlign: "top" }}>
              <div
                style={{
                  textAlign: "center",
                  borderBottom: "2px solid #000",
                  padding: "4px 6px 5px",
                }}
              >
                <img
                  src="/logo.png"
                  alt={company.name || "Your Company"}
                  style={{ display: "block", margin: "0 auto 3px", height: 32 }}
                />
                {title && <div style={{ fontSize: 10, fontWeight: 600 }}>{title}</div>}
                {company.address && <div style={{ fontSize: 10 }}>{company.address}</div>}
                {(company.phone || company.email) && (
                  <div style={{ fontSize: 10 }}>
                    {company.phone && <>Phone: {company.phone}</>}
                    {company.phone && company.email && " · "}
                    {company.email && <>Email: {company.email}</>}
                  </div>
                )}
                {gstOn && company.gstin && (
                  <div style={{ fontSize: 10, fontWeight: 600 }}>GSTIN: {company.gstin}</div>
                )}
              </div>
            </td>
          </tr>

          {/* ── Party + bill meta ──────────────────────────────────────── */}
          <tr>
            <td style={{ padding: 0, verticalAlign: "top" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <tbody>
                  <tr>
                    <td style={{ ...cell, verticalAlign: "top", borderBottom: BORDER }}>
                      <div style={{ fontSize: 11, fontWeight: 700 }}>
                        M/s. {inv.partyName || "—"}
                      </div>
                      {partyAddress && (
                        <div style={{ fontSize: 9.5, whiteSpace: "pre-line", marginTop: 1 }}>
                          {partyAddress}
                        </div>
                      )}
                      <div style={{ fontSize: 9.5, marginTop: 1 }}>
                        Mob. No.:- {inv.partyPhone || ""}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: 0,
                        width: "47%",
                        verticalAlign: "top",
                        borderLeft: BORDER,
                        borderBottom: BORDER,
                      }}
                    >
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <tbody>
                          <tr>
                            <td style={{ ...label, width: "52%" }}>
                              {isSale ? "Estimate No." : "Bill No."}
                            </td>
                            <td style={cell}>: {inv.number}</td>
                          </tr>
                          <tr>
                            <td style={label}>{isSale ? "Estimate Date" : "Bill Date"}</td>
                            <td style={cell}>: {dmy(inv.date)}</td>
                          </tr>
                          <tr>
                            <td style={label}>Payment</td>
                            <td style={cell}>: {fmtMode(inv.paymentMode)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>

          {/* ── Item grid — the row that stretches to fill the sheet ───── */}
          <tr style={{ height: "100%" }}>
            <td style={{ padding: 0, verticalAlign: "top", height: "100%" }}>
              <table
                style={{
                  width: "100%",
                  height: "100%",
                  borderCollapse: "collapse",
                  tableLayout: "fixed",
                }}
              >
                <thead>
                  <tr>
                    <th style={{ ...th, width: "7%" }}>Sr.</th>
                    <th style={{ ...th, width: "38%", textAlign: "left" }}>PARTICULARS</th>
                    <th style={{ ...th, width: "15%" }}>Code</th>
                    <th style={{ ...th, width: "10%" }}>QTY</th>
                    <th style={{ ...th, width: "14%" }}>Rate</th>
                    <th style={{ ...th, width: "16%" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(({ l, amount }, i) => (
                    <tr key={l.id}>
                      <td style={{ ...body, textAlign: "center" }}>{i + 1}</td>
                      <td style={body}>
                        {l.name}
                        {l.discountPct > 0 && (
                          <span style={{ fontSize: rowFont * 0.85 }}> (Disc {l.discountPct}%)</span>
                        )}
                      </td>
                      <td style={{ ...body, textAlign: "center" }}>{codeByLine?.[l.id] ?? ""}</td>
                      <td style={{ ...body, textAlign: "right" }}>{qty(l.qty)}</td>
                      <td style={{ ...body, textAlign: "right" }}>{money(l.price)}</td>
                      <td style={{ ...body, textAlign: "right" }}>{money(amount)}</td>
                    </tr>
                  ))}
                  {/* Absorbs every remaining pixel of the sheet, keeping the
                      column rules running down to the Sub-Total line. */}
                  <tr style={{ height: "100%" }}>
                    <td style={filler} />
                    <td style={filler} />
                    <td style={filler} />
                    <td style={filler} />
                    <td style={filler} />
                    <td style={filler} />
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ ...foot, textAlign: "right" }} colSpan={3}>
                      Sub-Total:-
                    </td>
                    <td style={{ ...foot, textAlign: "right" }}>{qty(totalQty)}</td>
                    <td style={foot} />
                    <td style={{ ...foot, textAlign: "right" }}>{money(lineAmountTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </td>
          </tr>

          {/* ── Balance block + totals ─────────────────────────────────── */}
          <tr>
            <td style={{ padding: 0, verticalAlign: "top" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: 0, verticalAlign: "top" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <tbody>
                          {showBalances && (
                            <tr>
                              <td style={label}>Previous Balance</td>
                              <td style={{ ...cell, textAlign: "right" }}>
                                : {money(previousBalance)}
                              </td>
                            </tr>
                          )}
                          <tr>
                            <td style={label}>New Bill Amount</td>
                            <td style={{ ...cell, textAlign: "right" }}>: {money(inv.total)}</td>
                          </tr>
                          {paidNow > 0 && (
                            <tr>
                              <td style={label}>{isSale ? "Received" : "Paid"}</td>
                              <td style={{ ...cell, textAlign: "right" }}>: {money(paidNow)}</td>
                            </tr>
                          )}
                          {showBalances && (
                            <tr style={{ fontWeight: 700 }}>
                              <td style={label}>Closing Balance</td>
                              <td style={{ ...cell, textAlign: "right" }}>
                                : {money(closingBalance)}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </td>
                    <td
                      style={{
                        padding: 0,
                        width: "47%",
                        verticalAlign: "top",
                        borderLeft: BORDER,
                      }}
                    >
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <tbody>
                          {gstOn &&
                            inv.taxAmount > 0 &&
                            totalsRow("Taxable Value", money(taxableTotal))}
                          {gstOn &&
                            inv.taxAmount > 0 &&
                            totalsRow("CGST", money(inv.taxAmount / 2))}
                          {gstOn &&
                            inv.taxAmount > 0 &&
                            totalsRow("SGST", money(inv.taxAmount / 2))}
                          {inv.discount > 0 && totalsRow("Discount", `- ${money(inv.discount)}`)}
                          {!!inv.shippingCharge &&
                            inv.shippingCharge > 0 &&
                            totalsRow("Shipping", money(inv.shippingCharge))}
                          {/* Only when the bill was actually rounded — a
                              permanent "Round off 0.00" line is noise. */}
                          {!!inv.roundOff &&
                            Math.abs(inv.roundOff) > 0.001 &&
                            totalsRow("Round off", money(inv.roundOff))}
                          <tr>
                            <td
                              style={{
                                ...label,
                                fontWeight: 800,
                                fontSize: 12,
                                borderTop: BORDER,
                              }}
                            >
                              TOTAL :
                            </td>
                            <td
                              style={{
                                ...cell,
                                textAlign: "right",
                                fontWeight: 800,
                                fontSize: 12,
                                borderTop: BORDER,
                              }}
                            >
                              {money(inv.total)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>

          {/* ── Signatures ─────────────────────────────────────────────── */}
          <tr>
            <td style={{ padding: 0, verticalAlign: "bottom", borderTop: BORDER }}>
              <div
                style={{
                  textAlign: "right",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px 0",
                }}
              >
                For {company.name || "Company"}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 9.5,
                  fontWeight: 600,
                  padding: "18px 6px 3px",
                }}
              >
                <span>Receiver's Signatory</span>
                <span>Authorized Signatory</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Cashback footer — customer-facing, only when the referral program
          is actually running (see Settings). The party's live balance
          already reflects THIS bill's own accrual/redemption, since this
          renders after the save that produced it. */}
      {isSale && company.referralEnabled && (
        <div style={{ marginTop: 6, fontSize: 8.5, borderTop: "1px dashed #000", paddingTop: 4 }}>
          <div style={{ fontWeight: 700 }}>
            Your Cashback Balance Available: ₹{money(PartyRepo.get(inv.partyId)?.referralWalletBalance ?? 0)}
          </div>
          {!!inv.redeemedCashback && <div>Cashback redeemed on this bill: ₹{money(inv.redeemedCashback)}</div>}
          <div>
            Note: Pending balances will be added based on program terms. For more details contact
            store manager.
          </div>
          <div>
            When you refer a friend, you get {company.referralPercent ?? 10}% and your friend gets{" "}
            {company.referralPercent ?? 10}% cashback on their next service.
          </div>
          {/* <div>Disc: Discount, CB: Cashback</div> */}
        </div>
      )}
    </div>
  );
}
