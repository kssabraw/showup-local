import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MapPin, Phone, Globe, Star, Building2, Loader2, ExternalLink, Trash2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BUSINESS_PROFILES_KEY } from "@/hooks/useBusinessProfiles";


interface BusinessProfile {
  id: string;
  gbp_place_id: string;
  business_name: string;
  description: string | null;
  address: string;
  phone: string | null;
  website: string | null;
  logo: string | null;
  photo: string | null;
  gbp_category: string;
  gbp_categories: string[];
  gbp_rating: number | null;
  gbp_review_count: number | null;
  google_maps_uri: string | null;
  analysis_status: string | null;
  hours: any | null;
  reviews: any | null;
  created_at: string;
}

const LocationsView = ({ onSelectBusiness }: { onSelectBusiness: (id: string) => void }) => {
  const queryClient = useQueryClient();
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchBusinesses();
  }, []);

  const fetchBusinesses = async () => {
    try {
      const { data, error } = await supabase
        .from("business_profiles")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setBusinesses((data as any[]) || []);
    } catch (err) {
      console.error("Error fetching businesses:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    if (!confirmId) return;
    setRemoving(true);
    try {
      const { error } = await supabase
        .from("business_profiles")
        .delete()
        .eq("id", confirmId);
      if (error) throw error;
      setBusinesses((prev) => prev.filter((b) => b.id !== confirmId));
    } catch (err) {
      console.error("Error removing business:", err);
    } finally {
      setRemoving(false);
      setConfirmId(null);
    }
  };

  const handleRefreshGBP = async (e: React.MouseEvent, b: BusinessProfile) => {
    e.stopPropagation();
    if (refreshingIds.has(b.id)) return;
    setRefreshingIds((prev) => new Set(prev).add(b.id));
    try {
      const { data, error } = await supabase.functions.invoke("google-places", {
        body: { action: "details", place_id: b.gbp_place_id },
      });
      if (error) throw new Error(error.message || "Edge function error");
      if (!data?.details) throw new Error(data?.error || "No details returned from GBP");
      const d = data.details;
      const updates = {
        business_name: d.name || b.business_name,
        description: d.description || b.description,
        address: d.address || b.address,
        phone: d.phone || b.phone,
        website: d.website || b.website,
        logo: d.logo || b.logo,
        photo: d.photo || b.photo,
        gbp_category: d.category || b.gbp_category,
        gbp_categories: d.categories ?? b.gbp_categories,
        gbp_rating: d.rating ?? b.gbp_rating,
        gbp_review_count: d.review_count ?? b.gbp_review_count,
        google_maps_uri: d.google_maps_uri || b.google_maps_uri,
        hours: d.hours ?? b.hours,
        reviews: (Array.isArray(d.reviews) && d.reviews.length > 0) ? d.reviews : b.reviews,
      };
      await supabase.from("business_profiles").update(updates).eq("id", b.id);
      setBusinesses((prev) => prev.map((x) => x.id === b.id ? { ...x, ...updates } : x));
      queryClient.invalidateQueries({ queryKey: BUSINESS_PROFILES_KEY });
    } catch (err) {
      console.error("GBP refresh error:", err);
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(b.id);
        return next;
      });
    }
  };

  const confirmBusiness = businesses.find((b) => b.id === confirmId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Locations</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Your saved business profiles.
        </p>
      </div>

      {businesses.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Building2 className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No locations yet. Search for your business to add one.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {businesses.map((b) => (
            <div
              key={b.id}
              onClick={() => onSelectBusiness(b.id)}
              className="bg-card rounded-xl border border-border p-5 flex items-start gap-4 hover:border-accent/40 transition-colors cursor-pointer"
            >
              {(b.logo || b.photo) && (
                <img
                  src={b.logo || b.photo || ""}
                  alt={`${b.business_name} logo`}
                  className="w-12 h-12 rounded-lg object-cover border border-border flex-shrink-0"
                />
              )}
              {!b.logo && !b.photo && (
                <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-5 h-5 text-muted-foreground" />
                </div>
              )}

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{b.business_name}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">{b.gbp_category}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {b.gbp_rating != null && (
                      <div className="flex items-center gap-1">
                        <Star className="w-3.5 h-3.5 text-warning fill-warning" />
                        <span className="text-xs font-semibold text-foreground">{b.gbp_rating}</span>
                        {b.gbp_review_count != null && (
                          <span className="text-xs text-muted-foreground">({b.gbp_review_count})</span>
                        )}
                      </div>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmId(b.id); }}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Remove location"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {b.address}
                  </span>
                  {b.phone && (
                    <span className="flex items-center gap-1">
                      <Phone className="w-3 h-3" />
                      {b.phone}
                    </span>
                  )}
                  {b.website && (
                    <a
                      href={b.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      <Globe className="w-3 h-3" />
                      Website
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                </div>

                {b.description && (
                  <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{b.description}</p>
                )}

                <div className="mt-3 pt-3 border-t border-border flex items-center justify-end">
                  <button
                    onClick={(e) => handleRefreshGBP(e, b)}
                    disabled={refreshingIds.has(b.id)}
                    className="flex items-center gap-1 text-[11px] font-medium text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {refreshingIds.has(b.id)
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> Updating…</>
                      : <><RefreshCw className="w-3 h-3" /> Update from GBP</>}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">Remove location?</h2>
            <p className="text-sm text-muted-foreground mt-2">
              <span className="font-medium text-foreground">{confirmBusiness?.business_name}</span> will be permanently removed from your account. This cannot be undone.
            </p>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setConfirmId(null)}
                disabled={removing}
                className="flex-1 px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRemove}
                disabled={removing}
                className="flex-1 px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
              >
                {removing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LocationsView;
