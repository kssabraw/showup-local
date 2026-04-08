import {
  LayoutDashboard,
  FileText,
  MapPin,
  Settings,
  Plus,
  ChevronLeft,
  Zap,
  ClipboardList,
  Store,
  Newspaper,
  ShieldCheck,
  ScanSearch,
  BookMarked,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCredits } from "@/hooks/useCredits";

interface SidebarProps {
  activeItem: string;
  onItemClick: (item: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  isAdmin?: boolean;
}

const navItems = [
  { id: "dashboard",       label: "Dashboard",       icon: LayoutDashboard },
  { id: "content",         label: "Content",         icon: FileText },
  { id: "saved-pages",     label: "Saved Pages",     icon: BookMarked },
  { id: "planning",        label: "Planning",        icon: ClipboardList },
  { id: "score-my-page",   label: "Score My Page",   icon: ScanSearch },
  { id: "press-releases",  label: "Press Releases",  icon: Newspaper },
  { id: "locations",       label: "Locations",       icon: MapPin },
  { id: "settings",        label: "Settings",        icon: Settings },
];

const comingSoonItems = [
  { id: "gbp-posts", label: "GBP Posts", icon: Store },
];

const AppSidebar = ({ activeItem, onItemClick, collapsed, onToggle, isAdmin }: SidebarProps) => {
  const { data: credits } = useCredits();
  const balance = credits?.balance ?? null;
  const monthly = credits?.monthlyBalance ?? null;
  const bonus = credits?.bonusCredits ?? 0;
  const perMonth = credits?.perMonth ?? 60;
  const pct = monthly !== null ? Math.min(100, Math.round((monthly / perMonth) * 100)) : null;
  const low = balance !== null && balance <= 5;

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 h-screen bg-sidebar text-sidebar-foreground flex flex-col transition-all duration-300 z-50",
        collapsed ? "w-16" : "w-60"
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 h-16 border-b border-sidebar-border">
        <div className="w-8 h-8 rounded-lg bg-sidebar-primary flex items-center justify-center flex-shrink-0">
          <Zap className="w-4 h-4 text-sidebar-primary-foreground" />
        </div>
        {!collapsed && (
          <span className="font-display font-bold text-lg tracking-tight text-sidebar-accent-foreground">
            ShowUP
          </span>
        )}
      </div>

      {/* New Location Button */}
      <div className="px-3 pt-4 pb-2">
        <button
          onClick={() => onItemClick("new")}
          className={cn(
            "w-full flex items-center gap-2 rounded-lg bg-sidebar-primary text-sidebar-primary-foreground font-medium text-sm transition-colors hover:opacity-90",
            collapsed ? "justify-center p-2" : "px-3 py-2.5"
          )}
        >
          <Plus className="w-4 h-4 flex-shrink-0" />
          {!collapsed && "New Location"}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-2 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeItem === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onItemClick(item.id)}
              className={cn(
                "w-full flex items-center gap-3 rounded-lg text-sm font-medium transition-colors",
                collapsed ? "justify-center p-2" : "px-3 py-2.5",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && item.label}
            </button>
          );
        })}

        {/* Admin item */}
        {isAdmin && (
          <button
            onClick={() => onItemClick("admin")}
            className={cn(
              "w-full flex items-center gap-3 rounded-lg text-sm font-medium transition-colors",
              collapsed ? "justify-center p-2" : "px-3 py-2.5",
              activeItem === "admin"
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
            )}
          >
            <ShieldCheck className="w-4 h-4 flex-shrink-0" />
            {!collapsed && "Admin"}
          </button>
        )}

        {/* Coming soon items */}
        {comingSoonItems.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.id}
              title={collapsed ? `${item.label} — Coming Soon` : undefined}
              className={cn(
                "w-full flex items-center gap-3 rounded-lg text-sm font-medium cursor-not-allowed opacity-50",
                collapsed ? "justify-center p-2" : "px-3 py-2.5",
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">{item.label}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide bg-sidebar-border text-sidebar-foreground/60 px-1.5 py-0.5 rounded">
                    Soon
                  </span>
                </>
              )}
            </div>
          );
        })}
      </nav>

      {/* Credit balance */}
      {!collapsed && balance !== null && (
        <div className="px-3 pb-3">
          <div className="rounded-lg bg-sidebar-accent/40 px-3 py-2.5 space-y-2">
            <p className="text-xs font-semibold text-sidebar-foreground/70 mb-0.5">Credits</p>

            {/* Analysis / Content */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-sidebar-foreground/60">Analysis &amp; Content</span>
                <span className={cn("text-xs font-semibold tabular-nums", low ? "text-red-400" : "text-sidebar-accent-foreground")}>
                  {monthly ?? "–"} / {perMonth}
                  {bonus > 0 && <span className="text-primary ml-1">+{bonus}</span>}
                </span>
              </div>
              <div className="h-1 rounded-full bg-sidebar-border overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", low ? "bg-red-400" : "bg-sidebar-primary")}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              {low && <p className="text-xs text-red-400 mt-1">Running low</p>}
            </div>

            {/* Map pack checks */}
            {(() => {
              const used = credits?.rankabilityUsed ?? 0;
              const limit = credits?.rankabilityLimit ?? 50;
              const remaining = limit - used;
              const mapPct = Math.min(100, Math.round((remaining / limit) * 100));
              const mapLow = remaining <= 5;
              return (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-sidebar-foreground/60">Map Pack Checks</span>
                    <span className={cn("text-xs font-semibold tabular-nums", mapLow ? "text-red-400" : "text-sidebar-accent-foreground")}>
                      {remaining} / {limit}
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-sidebar-border overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all", mapLow ? "bg-red-400" : "bg-sidebar-primary")}
                      style={{ width: `${mapPct}%` }}
                    />
                  </div>
                  {mapLow && <p className="text-xs text-red-400 mt-1">Running low</p>}
                </div>
              );
            })()}

            {/* Press releases */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-sidebar-foreground/60">Press Releases</span>
              <span className="text-xs font-semibold tabular-nums text-sidebar-accent-foreground">
                {credits?.prCredits ?? 0} remaining
              </span>
            </div>
          </div>
        </div>
      )}
      {collapsed && balance !== null && (
        <div className="px-3 pb-3 flex justify-center">
          <div className={cn("text-xs font-bold tabular-nums", low ? "text-red-400" : "text-sidebar-foreground/60")}>
            {balance}
          </div>
        </div>
      )}

      {/* Collapse toggle */}
      <div className="px-3 pb-4">
        <button
          onClick={onToggle}
          className="w-full flex items-center justify-center p-2 rounded-lg text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
        >
          <ChevronLeft className={cn("w-4 h-4 transition-transform", collapsed && "rotate-180")} />
        </button>
      </div>
    </aside>
  );
};

export default AppSidebar;

