import { ItemRepo } from "@/repositories";
import type { LineItem } from "@/types";

/**
 * The shop code (Items → Item Code, stored as `Item.sku`) for each line on a
 * bill, keyed by `LineItem.id` — what fills the printed Code column.
 *
 * Read live from the item record rather than snapshotted onto the invoice, so
 * codes entered today show up on bills saved months ago, and nothing about how
 * invoices are stored has to change. A purely synchronous read of the
 * in-memory repository cache, like every other read in this app.
 *
 * A line whose item has no code (or whose item collection isn't loaded — a
 * permission-scoped user may not have Master Data) simply gets no entry, and
 * the Code cell prints blank.
 */
export function itemCodesByLine(lineItems: LineItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lineItems) {
    const code = ItemRepo.get(l.itemId)?.sku?.trim();
    if (code) out[l.id] = code;
  }
  return out;
}
