import { useState, useEffect } from "react";
import AppSidebar from "@/components/AppSidebar";
import DashboardView from "@/components/DashboardView";
import NewContentView from "@/components/NewContentView";
import PlanningView from "@/components/PlanningView";
import BusinessSearchView, { type BusinessDetails } from "@/components/BusinessSearchView";
import LocationsView from "@/components/LocationsView";
import LocationDetailView from "@/components/LocationDetailView";
import LoginView from "@/components/LoginView";
import SettingsView from "@/components/SettingsView";
import PressReleasesView from "@/components/PressReleasesView";
import ScoreMyPageView from "@/components/ScoreMyPageView";
import SavedPagesView from "@/components/SavedPagesView";
import AdminView from "@/components/AdminView";
import NotificationBell from "@/components/NotificationBell";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { nlp } from "@/lib/nlp-client";
import type { Session } from "@supabase/supabase-js";

const Index = () => {
  const { toast } = useToast();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [activeItem, setActiveItem] = useState("dashboard");
  const [collapsed, setCollapsed] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [planningKeyword, setPlanningKeyword] = useState("");
  const [planningLocation, setPlanningLocation] = useState("");
  const [onboardingBusinessId, setOnboardingBusinessId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // When Supabase processes a password-reset link it fires PASSWORD_RECOVERY.
      // Route straight to Settings so the user can set a new password.
      if (event === "PASSWORD_RECOVERY") setActiveItem("settings");
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setIsAdmin(false); return; }
    supabase
      .from("profiles" as any)
      .select("role")
      .eq("id", session.user.id)
      .single()
      .then(({ data }) => setIsAdmin((data as any)?.role === "admin"));
  }, [session?.user.id]);

  const handleItemClick = (item: string) => {
    setActiveItem(item);
    setSelectedLocationId(null);
  };

  const handleBusinessConfirm = async (business: BusinessDetails) => {
    // address is not required — service area businesses legitimately have no address
    if (!business.place_id || !business.name) {
      toast({
        title: "Missing business info",
        description: "This listing is missing a Place ID or name. Please try searching again or selecting a different result.",
        variant: "destructive",
      });
      return;
    }

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
            reviews: business.reviews ?? [],
            latitude: business.latitude,
            longitude: business.longitude,
            hours: business.hours,
            google_maps_uri: business.google_maps_uri,
          },
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      // Navigate directly to the newly added business detail view
      const { data: saved } = await supabase
        .from("business_profiles")
        .select("id")
        .eq("gbp_place_id", business.place_id)
        .single();
      if (saved?.id) {
        setOnboardingBusinessId(saved.id);
      }
      setActiveItem("content");

      // Trigger background analysis if the business has a website
      if (business.website) {
        triggerBusinessAnalysis(business);
      }
    } catch (err) {
      console.error("Error saving business:", err);
      toast({
        title: "Failed to save business",
        description: err instanceof Error ? err.message : "An unexpected error occurred.",
        variant: "destructive",
      });
    }
  };

  const triggerBusinessAnalysis = async (business: BusinessDetails) => {
    try {
      const { data: saved } = await supabase
        .from("business_profiles")
        .select("id")
        .eq("gbp_place_id", business.place_id)
        .single();
      if (!saved) return;

      await supabase
        .from("business_profiles")
        .update({ analysis_status: "running" })
        .eq("id", saved.id);

      const result = await nlp.analyzeBusiness({
        website_url: business.website!,
        business_name: business.name,
        gbp_category: business.category,
        gbp_categories: business.categories || [],
      });

      await supabase
        .from("business_profiles")
        .update({
          existing_pages: result.existing_pages,
          detected_icp: result.detected_icp,
          differentiators: result.differentiators,
          analysis_status: result.analysis_status,
        })
        .eq("id", saved.id);
    } catch (err) {
      console.error("Background analysis error:", err);
    }
  };

  // Still loading session — render nothing to avoid flash
  if (session === undefined) return null;

  // Not authenticated — show login
  if (session === null) return <LoginView onAuth={() => {}} />;

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar
        activeItem={activeItem}
        onItemClick={handleItemClick}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        isAdmin={isAdmin}
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
            <NotificationBell
              onNavigateToPR={() => setActiveItem("press-releases")}
            />
            <span className="text-xs text-muted-foreground hidden sm:block">{session.user.email}</span>
            <button
              onClick={() => supabase.auth.signOut()}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign out
            </button>
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
              {(session.user.email?.[0] ?? "U").toUpperCase()}
            </div>
          </div>
        </header>
        <div className="p-6">
          {activeItem === "dashboard" && <DashboardView onNavigate={handleItemClick} />}
          {activeItem === "new" && (
            <BusinessSearchView
              onBack={() => setActiveItem("dashboard")}
              onConfirm={handleBusinessConfirm}
            />
          )}
          {activeItem === "content" && (
            <NewContentView
              onBack={() => { setOnboardingBusinessId(null); setActiveItem("dashboard"); }}
              initialKeyword={planningKeyword}
              initialLocation={planningLocation}
              initialBusinessId={onboardingBusinessId ?? undefined}
              isOnboarding={!!onboardingBusinessId}
            />
          )}
          {activeItem === "locations" && !selectedLocationId && (
            <LocationsView
              onSelectBusiness={(id) => setSelectedLocationId(id)}
            />
          )}
          {activeItem === "locations" && selectedLocationId && (
            <LocationDetailView
              businessId={selectedLocationId}
              onBack={() => setSelectedLocationId(null)}
            />
          )}
          {activeItem === "planning" && (
            <PlanningView
              initialKeyword={planningKeyword}
              initialLocation={planningLocation}
              onCreatePage={(kw, loc) => {
                setPlanningKeyword(kw);
                setPlanningLocation(loc);
                setActiveItem("content");
              }}
            />
          )}
          {activeItem === "score-my-page" && <ScoreMyPageView />}
          {activeItem === "saved-pages" && <SavedPagesView />}
          {activeItem === "press-releases" && <PressReleasesView />}
          {activeItem === "admin" && isAdmin && <AdminView />}
          {activeItem === "settings" && session && (
            <SettingsView session={session} />
          )}
        </div>
      </main>
    </div>
  );
};

export default Index;
