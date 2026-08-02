import { type ReactNode } from "react";

/**
 * Standard page header — same bar every list/detail page in the app uses,
 * so switching pages never feels like switching apps. `icon` renders plain
 * (no colored badge box) — `iconClassName` only sets its color, e.g.
 * "text-success" for Sale pages, "text-warning" for Purchase.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  icon,
  iconClassName = "text-primary",
  mobileAction,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  icon?: ReactNode;
  iconClassName?: string;
  /** Rendered at the far right of the title row, mobile only (hidden at
   * sm: and up, where `actions` already sits inline next to the title with
   * no spare room). Fills what would otherwise be dead space next to a
   * short title — e.g. a compact "Filters" button for a page whose full
   * filter row doesn't fit on a phone and needs to move into a sheet. */
  mobileAction?: ReactNode;
}) {
  return (
    <div className="no-print bg-white border-b px-3 py-2.5 sm:px-5 sm:py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
      <div className="flex items-center justify-between sm:justify-start gap-2 sm:gap-3 min-w-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {icon && <div className={`shrink-0 flex items-center justify-center ${iconClassName}`}>{icon}</div>}
          <div className="min-w-0">
            <h1 className="text-[15px] sm:text-[17px] font-bold tracking-tight leading-tight text-gray-800 truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-[11px] sm:text-[12px] text-gray-400 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
        </div>
        {mobileAction && <div className="sm:hidden shrink-0">{mobileAction}</div>}
      </div>
      {actions && (
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">{actions}</div>
      )}
    </div>
  );
}
