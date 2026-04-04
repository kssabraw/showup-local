import {
  LayoutDashboard,
  FileText,
  MapPin,
  Settings,
  Plus,
  ChevronLeft,
  Zap,
  ClipboardList
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarProps {
  activeItem: string;
  onItemClick: (item: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "content", label: "Content", icon: FileText },
  { id: "planning", label: "Planning", icon: ClipboardList },
  { id: "locations", label: "Locations", icon: MapPin },
  { id: "settings", label: "Settings", icon: Settings },
];

const AppSidebar = ({ activeItem, onItemClick, collapsed, onToggle }: SidebarProps) => {
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
      </nav>

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
