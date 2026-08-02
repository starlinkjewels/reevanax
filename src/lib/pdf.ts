import { renderPdfServerFn, renderPdfBase64ServerFn } from "@/lib/pdfServer";
import { auth } from "@/lib/firebase";

/** The render server fns are auth-gated (they'd otherwise be an open
 * headless-Chromium endpoint) — every call must carry the caller's token. */
async function requireIdToken(): Promise<string> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Not signed in");
  return token;
}

/** Concatenates every same-origin stylesheet the page has already loaded and
 * parsed, so the headless-rendered copy gets the exact same CSS (including
 * the `@media print` rules) as this document. Reads the already-parsed
 * CSSOM rather than re-fetching the stylesheet file — a fetch of an
 * asset URL can silently fail (CORS, CSP, caching quirks) and there'd be no
 * sign of it beyond a blank/unstyled PDF. */
function collectAppStylesheets(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
    } catch {
      // Cross-origin sheet (e.g. a font CDN) — can't read its rules, skip it.
    }
  }
  return parts.join("\n");
}

/** The exported markup carries no `<script>` tags, only the printable
 * subtree's HTML plus the app's own compiled CSS, so the server just prints
 * a static page — it never boots the SPA or touches Firestore. */
function buildPrintableHtml(el: HTMLElement): string {
  const css = collectAppStylesheets();
  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    `<base href="${window.location.origin}/">` +
    `<style>${css}</style></head><body>${el.outerHTML}</body></html>`
  );
}

/** Renders a DOM node to a real, vector-quality PDF server-side (headless
 * Chromium), rather than rasterizing a screenshot — text stays crisp at any
 * zoom and the file is far smaller.
 *
 * `pageWidthMm` is for thermal receipts (80mm/58mm rolls) — pass it instead
 * of relying on the printed element's own `@page` CSS rule, since Puppeteer
 * ignores `@page`'s "auto" height keyword and silently falls back to full
 * A4 without it. */
async function elementToPdfBlob(
  el: HTMLElement,
  orientation: "portrait" | "landscape" = "landscape",
  pageWidthMm?: number,
): Promise<Blob> {
  const res = await renderPdfServerFn({
    data: {
      callerIdToken: await requireIdToken(),
      html: buildPrintableHtml(el),
      landscape: orientation === "landscape",
      pageWidthMm,
    },
  });
  return res.blob();
}

/** Same rendering as elementToPdfBlob, but returns base64 — for handing the
 * PDF to another server (e.g. WhatsApp send) that can't consume a Blob. */
export async function elementToPdfBase64(
  el: HTMLElement,
  orientation: "portrait" | "landscape" = "landscape",
  pageWidthMm?: number,
): Promise<string> {
  const { pdfBase64 } = await renderPdfBase64ServerFn({
    data: {
      callerIdToken: await requireIdToken(),
      html: buildPrintableHtml(el),
      landscape: orientation === "landscape",
      pageWidthMm,
    },
  });
  return pdfBase64;
}

function pdfFilename(name: string): string {
  return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Saves a real .pdf file straight to Downloads — no print dialog, no manual
 * "Save as PDF" step. */
export async function downloadElementAsPdf(
  el: HTMLElement,
  filename: string,
  orientation?: "portrait" | "landscape",
  pageWidthMm?: number,
) {
  const blob = await elementToPdfBlob(el, orientation, pageWidthMm);
  triggerDownload(blob, pdfFilename(filename));
}

export function canShareFile(file: File): boolean {
  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
  return typeof nav.share === "function" && !!nav.canShare?.({ files: [file] });
}

/** Renders the PDF and wraps it as a shareable File — but does NOT open the
 * share sheet yet. Generating the PDF is an async server round trip, and
 * Safari silently refuses navigator.share() once too much time has passed
 * since the click that triggered it, so calling share() right after this
 * await (like the old single-step shareElementAsPdf used to) works some of
 * the time and silently fails the rest, depending on how long the render
 * happened to take. Split in two so the caller can react to a second, truly
 * immediate click — see shareFileNow. */
export async function prepareShareFile(
  el: HTMLElement,
  filename: string,
  orientation?: "portrait" | "landscape",
  pageWidthMm?: number,
): Promise<File> {
  const name = pdfFilename(filename);
  const blob = await elementToPdfBlob(el, orientation, pageWidthMm);
  return new File([blob], name, { type: "application/pdf" });
}

/** Opens the OS share sheet (WhatsApp/Mail/AirDrop/...) with the given file.
 * MUST be called directly inside a click handler with no `await` before it
 * in that same handler — this needs to be the immediate result of a user
 * gesture or Safari blocks it. Use with a file from prepareShareFile that
 * was already generated (from an earlier click), not one being awaited
 * right now. */
export async function shareFileNow(file: File): Promise<"shared" | "cancelled" | "failed"> {
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  try {
    // `text` is a no-op for targets that accept files, but for a target
    // that only registers as a text share handler (e.g. WhatsApp Desktop
    // on Windows) it's the only part of this call that actually arrives —
    // the OS hands the share off silently, so the web page can't detect
    // or prevent a target dropping the attachment.
    await nav.share!({ files: [file], title: file.name, text: file.name });
    return "shared";
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") return "cancelled";
    return "failed";
  }
}

export function downloadFile(file: File) {
  triggerDownload(file, file.name);
}

/**
 * Turns whatever the PDF pipeline threw into something worth putting in a
 * toast, and logs the original to the console.
 *
 * PDF generation is a server round trip (auth check → headless Chromium →
 * bytes back), so it can fail for reasons the user can actually act on: a
 * sign-in that expired, no internet, or a server that's missing its
 * credentials. Callers used to `catch {}` and show one fixed "try Print
 * instead" line for all of them, which made every cause look identical and
 * left nothing to debug from.
 */
export function pdfErrorReason(err: unknown, context: string): string {
  console.error(`PDF generation failed (${context})`, err);
  const msg = (err instanceof Error ? err.message : String(err ?? "")).trim();
  if (!msg) return "unknown error";
  if (/not signed in|id ?token|expired|auth/i.test(msg)) return "your sign-in expired — sign in again";
  if (/failed to fetch|network|load failed|offline/i.test(msg)) return "no connection to the server";
  if (/service_account|FIREBASE_SERVICE_ACCOUNT_KEY/i.test(msg))
    return "the server is missing its Firebase key — check the deployment settings";
  if (/chrom/i.test(msg)) return "the server could not start its PDF renderer";
  // Anything else: show it verbatim rather than hiding it behind a guess.
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
}
