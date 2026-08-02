import { useEffect, useState } from "react";
import { useWorkspace } from "@/store/workspace";
import { useNavigate } from "@tanstack/react-router";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { PartyRepo, ItemRepo, SalesRepo, PurchaseRepo } from "@/repositories";
import { usePermissions } from "@/hooks/usePermissions";
import { useRepoData } from "@/hooks/useRepoData";
import { Users, Package, ShoppingCart, Truck } from "lucide-react";

export function GlobalSearch() {
  useRepoData();
  const { globalSearchOpen, setGlobalSearch } = useWorkspace();
  const navigate = useNavigate();
  const { isOwner, canView } = usePermissions();
  const [data, setData] = useState<{
    parties: any[];
    items: any[];
    sales: any[];
    purchases: any[];
  }>({ parties: [], items: [], sales: [], purchases: [] });

  // Belt-and-suspenders on top of permission-aware hydration (a repo for a
  // module the user can't view is never populated in the first place, so
  // .all() is already empty for them) — an explicit check here means this
  // stays safe even if hydration's own scoping ever regresses later.
  useEffect(() => {
    if (globalSearchOpen) {
      setData({
        parties: isOwner || canView("masterData") ? PartyRepo.all() : [],
        items: isOwner || canView("masterData") ? ItemRepo.all() : [],
        sales: isOwner || canView("sales") ? SalesRepo.all() : [],
        purchases: isOwner || canView("purchaseExpenses") ? PurchaseRepo.all() : [],
      });
    }
  }, [globalSearchOpen, isOwner, canView]);

  const goParty = (id: string) => {
    setGlobalSearch(false);
    navigate({ to: "/parties/$id", params: { id } });
  };
  const goItem = (id: string) => {
    setGlobalSearch(false);
    navigate({ to: "/items/$id", params: { id } });
  };
  const goSale = (id: string) => {
    setGlobalSearch(false);
    navigate({ to: "/sales/$id", params: { id } });
  };
  const goPurchase = (id: string) => {
    setGlobalSearch(false);
    navigate({ to: "/purchase/$id", params: { id } });
  };

  return (
    <CommandDialog open={globalSearchOpen} onOpenChange={setGlobalSearch}>
      <Command>
        <CommandInput placeholder="Search parties, items, invoices..." autoFocus />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {data.parties.length > 0 && (
            <CommandGroup heading="Parties">
              {data.parties.slice(0, 6).map((p) => (
                <CommandItem
                  key={p.id}
                  onSelect={() => goParty(p.id)}
                  value={`party ${p.name} ${p.phone ?? ""}`}
                >
                  <Users className="h-3.5 w-3.5" />
                  {p.name}
                  {p.archived && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                      Archived
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">{p.phone}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {data.items.length > 0 && (
            <CommandGroup heading="Items">
              {data.items.slice(0, 6).map((i) => (
                <CommandItem
                  key={i.id}
                  onSelect={() => goItem(i.id)}
                  value={`item ${i.name} ${i.sku ?? ""}`}
                >
                  <Package className="h-3.5 w-3.5" />
                  {i.name}
                  <span className="ml-auto text-xs text-muted-foreground">Stock: {i.stock}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {data.sales.length > 0 && (
            <CommandGroup heading="Sales Invoices">
              {data.sales.slice(0, 6).map((s) => (
                <CommandItem
                  key={s.id}
                  onSelect={() => goSale(s.id)}
                  value={`sale ${s.number} ${s.partyName}`}
                >
                  <ShoppingCart className="h-3.5 w-3.5" />
                  {s.number} — {s.partyName}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {data.purchases.length > 0 && (
            <CommandGroup heading="Purchase Bills">
              {data.purchases.slice(0, 6).map((s) => (
                <CommandItem
                  key={s.id}
                  onSelect={() => goPurchase(s.id)}
                  value={`purchase ${s.number} ${s.partyName}`}
                >
                  <Truck className="h-3.5 w-3.5" />
                  {s.number} — {s.partyName}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
