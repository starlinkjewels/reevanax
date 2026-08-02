import { Search, Plus, Building2, ChevronDown, Menu, LogOut } from "lucide-react";
import { useWorkspace } from "@/store/workspace";
import { useNavigate } from "@tanstack/react-router";
import { CompanyRepo, stopRepos } from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { useEffect, useState } from "react";
import { signOut } from "firebase/auth";
import { auth, isBrowser } from "@/lib/firebase";
import { toast } from "sonner";

export function Topbar() {
  useRepoData();
  const { setGlobalSearch, toggleMobileNav } = useWorkspace();
  const navigate = useNavigate();
  const [company, setCompany] = useState(() => CompanyRepo.get());
  useEffect(() => {
    const t = setInterval(() => setCompany(CompanyRepo.get()), 2000);
    return () => clearInterval(t);
  }, []);
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    // Installed on the home screen (standalone mode), iOS draws the status
    // bar translucent right over the page instead of pushing it down — so
    // without this top padding for the notch/status-bar's safe area, the
    // header (menu button included) renders partly underneath it: only the
    // bottom sliver peeks out below the status bar, out of reach of taps.
    <div
      className="bg-card border-b border-border shrink-0"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <header className="h-14 text-foreground grid grid-cols-[auto_1fr_auto] md:flex items-center px-3 md:px-4 gap-2 md:gap-3">
        <button
          onClick={toggleMobileNav}
          className="md:hidden h-8 w-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground"
          title="Toggle menu"
        >
          <Menu className="h-4 w-4" />
        </button>

        {/* Full search bar — desktop only. Every list page already has its
          own page-specific search box right below the header, so a second
          generic search bar up here was redundant clutter on mobile. */}
        <button
          onClick={() => setGlobalSearch(true)}
          className="hidden md:flex flex-1 min-w-0 max-w-xl items-center gap-2 h-8 px-3.5 rounded-md bg-muted hover:bg-accent text-muted-foreground transition-colors ring-1 ring-border"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left text-sm truncate">
            Search customer, item, invoice…
          </span>
        </button>

        {/* Mobile — company name sits centered in the one header row,
          between the menu icon and the search/Sale actions. */}
        <span className="md:hidden text-center text-[13px] font-semibold text-foreground truncate px-2">
          {company.name}
        </span>

        <div className="hidden md:block flex-1" />

        {/* Mobile — compact search icon (opens the same global search
          overlay), on the right of the single row. The bottom nav's FAB is
          now the one and only "Add Sale" entry point on mobile, so a second
          Sale button up here was redundant clutter. */}
        <div className="md:hidden flex items-center gap-1.5 justify-self-end">
          <button
            onClick={() => setGlobalSearch(true)}
            className="h-8 w-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground shrink-0"
            title="Search"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>

        {/* Primary actions — desktop only. Add Sale is the one saturated
          accent in an otherwise neutral bar, so it stays the obvious place
          to click instead of competing with a bold background. */}
        <button
          onClick={() => navigate({ to: "/sales/new" })}
          className="hidden md:flex h-8 px-4 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 font-semibold text-sm items-center gap-1.5 shadow-sm transition"
        >
          <Plus className="h-4 w-4" /> Add Sale
        </button>
        {/* Purchase entry is secondary on mobile — reachable via the bottom
          nav's "More" drawer — so it doesn't compete for space here. */}
        <button
          onClick={() => navigate({ to: "/purchase/new" })}
          className="hidden md:flex h-8 px-3 md:px-4 rounded-md border border-input bg-background hover:bg-accent text-foreground font-semibold text-sm items-center gap-1.5 transition"
        >
          <Plus className="h-4 w-4" /> Add Purchase
        </button>

        <div className="hidden lg:block h-6 w-px bg-border mx-1" />
        <span className="hidden lg:inline text-[11px] text-muted-foreground tabular-nums">
          {today}
        </span>

        {/* Company + Logout — desktop only. Logout lives in the sidebar
          drawer on mobile instead. */}
        <button
          onClick={() => navigate({ to: "/settings" })}
          className="hidden md:flex items-center gap-2 pl-2 pr-2 h-8 rounded-md bg-muted hover:bg-accent ring-1 ring-border transition"
          title="Company settings"
        >
          <div className="h-6 w-6 rounded bg-primary-soft text-primary flex items-center justify-center">
            <Building2 className="h-3.5 w-3.5" />
          </div>
          <div className="flex flex-col items-start leading-tight">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Company
            </span>
            <span className="text-[12px] font-semibold text-foreground truncate max-w-[140px]">
              {company.name}
            </span>
          </div>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>

        <button
          onClick={async () => {
            if (!confirm("Logout from REEVANA X?")) return;
            try {
              stopRepos();
              await signOut(auth);
            } catch {
              toast.error("Logout failed — check your connection");
            }
          }}
          className="hidden md:flex h-8 w-8 rounded-full hover:bg-accent text-muted-foreground hover:text-destructive items-center justify-center transition"
          title={`Logout${isBrowser && auth.currentUser?.email ? ` (${auth.currentUser.email})` : ""}`}
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>
    </div>
  );
}
