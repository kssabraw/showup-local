import { useState } from "react";
import AppSidebar from "@/components/AppSidebar";
import DashboardView from "@/components/DashboardView";
import NewContentView from "@/components/NewContentView";
import BusinessSearchView, { type BusinessDetails } from "@/components/BusinessSearchView";
import { cn } from "@/lib/utils";

const Index = () => {
  const [activeItem, setActiveItem] = useState("dashboard");
  const [collapsed, setCollapsed] = useState(false);

  const handleItemClick = (item: string) => {
    setActiveItem(item);
  };

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar
        activeItem={activeItem}
        onItemClick={handleItemClick}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <main
        className={cn(
          "transition-all duration-300 min-h-screen",
          collapsed ? "ml-16" : "ml-60"
        )}
      >
        <header className="h-16 border-b border-border bg-card/80 backdrop-blur-sm flex items-center px-6 sticky top-0 z-40">
          <div className="flex-1" />
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
              SU
            </div>
          </div>
        </header>
        <div className="p-6">
          {activeItem === "dashboard" && <DashboardView />}
          {activeItem === "new" && (
            <BusinessSearchView
              onBack={() => setActiveItem("dashboard")}
              onConfirm={(business: BusinessDetails) => {
                console.log("Business confirmed:", business);
                setActiveItem("dashboard");
              }}
            />
          )}
          {activeItem === "content" && (
            <div>
              <h1 className="text-2xl font-display font-bold text-foreground">Content Library</h1>
              <p className="text-muted-foreground text-sm mt-1">Manage all your local SEO content pieces.</p>
            </div>
          )}
          {activeItem === "locations" && (
            <div>
              <h1 className="text-2xl font-display font-bold text-foreground">Locations</h1>
              <p className="text-muted-foreground text-sm mt-1">Manage your target locations and service areas.</p>
            </div>
          )}
          {activeItem === "analytics" && (
            <div>
              <h1 className="text-2xl font-display font-bold text-foreground">Analytics</h1>
              <p className="text-muted-foreground text-sm mt-1">Track performance across your content and locations.</p>
            </div>
          )}
          {activeItem === "settings" && (
            <div>
              <h1 className="text-2xl font-display font-bold text-foreground">Settings</h1>
              <p className="text-muted-foreground text-sm mt-1">Configure your ShowUP workspace.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default Index;
