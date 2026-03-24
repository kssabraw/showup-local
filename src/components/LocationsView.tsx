import { useState, useEffect } from "react";
import { MapPin, Phone, Globe, Star, Building2, Loader2, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

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
  created_at: string;
}

const LocationsView = () => {
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [loading, setLoading] = useState(true);

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
              className="bg-card rounded-xl border border-border p-5 flex items-start gap-4 hover:border-accent/40 transition-colors"
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
                  {b.gbp_rating != null && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Star className="w-3.5 h-3.5 text-warning fill-warning" />
                      <span className="text-xs font-semibold text-foreground">{b.gbp_rating}</span>
                      {b.gbp_review_count != null && (
                        <span className="text-xs text-muted-foreground">({b.gbp_review_count})</span>
                      )}
                    </div>
                  )}
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
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default LocationsView;
