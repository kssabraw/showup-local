import { useState } from "react";
import AppSidebar from "@/components/AppSidebar";
import DashboardView from "@/components/DashboardView";
import NewContentView from "@/components/NewContentView";
import BusinessSearchView, { type BusinessDetails } from "@/components/BusinessSearchView";
import LocationsView from "@/components/LocationsView";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const Index = () => {
  const [activeItem, setActiveItem] = useState("dashboard");
  const [collapsed, setCollapsed] = useState(false);

  const handleItemClick = (item: string) => {
    setActiveItem(item);
  };

  const handleBusinessConfirm = async (business: BusinessDetails) => {
    try {
      const { data, error } = await supabase.functions.invoke("dual-write-business", {
        body: {
          record: {
            gbp_place_id: business.place_id,
            business_name: business.name,
            description: business.description || null,
            address: business.address,
            phone: business.phone || null,
            website: business.website || null,
            logo: business.logo || null,
            photo: business.photo || null,
            gbp_category: business.category,
            gbp_categories: business.categories,
            gbp_rating: business.rating,
            gbp_review_count: business.review_count,
            latitude: business.latitude,
            longitude: business.longitude,
            hours: business.hours,
            google_maps_uri: business.google_maps_uri,
          },
        },
      });
      if (error) throw error;
      if (data?.external_error) {
        console.warn("External sync warning:", data.external_error);
      }
      setActiveItem("locations");
    } catch (err) {
      console.error("Error saving business:", err);
    }
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
              onConfirm={handleBusinessConfirm}
            />
          )}
          {activeItem === "content" && (
            <div>
              <h1 className="text-2xl font-display font-bold text-foreground">Content Library</h1>
              <p className="text-muted-foreground text-sm mt-1">Manage all your local SEO content pieces.</p>
            </div>
          )}
          {activeItem === "locations" && <LocationsView />}
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
