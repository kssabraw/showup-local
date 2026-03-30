import { useState, useEffect, useRef } from "react";
import { MapPin, Sparkles, ChevronDown, Building2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import AnalysisResultsView from "@/components/AnalysisResultsView";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";
const NLP_API_KEY = import.meta.env.VITE_NLP_API_KEY ?? "";

interface BusinessProfile {
  id: string;
  business_name: string;
  address: string;
  gbp_category: string;
  website: string | null;
  existing_pages: any[];
}

interface AnalysisResult {
  keyword: string;
  location: string;
  serp_urls: string[];
  related_keywords: {
    title: any[];
    h1: any[];
    h2_h3: any[];
    body: any[];
  };
  top_quadgrams: any[];
  google_entities: any[];
}

const NewContentView = ({ onBack, defaultLocation = "" }: { onBack: () => void; defaultLocation?: string }) => {
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [locationInput, setLocationInput] = useState(defaultLocation);
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingBusinesses, setLoadingBusinesses] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const locationDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchBusinesses();
  }, []);

  // Pre-fill location when business is selected
  useEffect(() => {
    if (selectedBusinessId) {
      const b = businesses.find((b) => b.id === selectedBusinessId);
      if (b) {
        const parts = b.address.split(",").map((s) => s.trim());
        if (parts.length >= 2) {
          const prefilled = parts.slice(1).join(", ") + ", United States";
          setLocation(prefilled);
          setLocationInput(prefilled);
        }
      }
    }
  }, [selectedBusinessId, businesses]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (locationContainerRef.current && !locationContainerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleLocationInput = (value: string) => {
    setLocationInput(value);
    setLocation(""); // unconfirmed until selected from list
    setShowSuggestions(true);
    if (locationDebounce.current) clearTimeout(locationDebounce.current);
    if (value.length < 2) {
      setLocationSuggestions([]);
      return;
    }
    locationDebounce.current = setTimeout(async () => {
      setLocationLoading(true);
      try {
        const { data } = await supabase
          .from("Locations")
          .select("Location")
          .ilike("Location", `%${value}%`)
          .limit(8);
        setLocationSuggestions((data || []).map((r: any) => r.Location));
      } finally {
        setLocationLoading(false);
      }
    }, 200);
  };

  const selectLocation = (loc: string) => {
    setLocation(loc);
    setLocationInput(loc);
    setLocationSuggestions([]);
    setShowSuggestions(false);
  };

  const fetchBusinesses = async () => {
    try {
      const { data, error } = await supabase
        .from("business_profiles")
        .select("id, business_name, address, gbp_category, website, existing_pages")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setBusinesses(data || []);
      if (data && data.length > 0) setSelectedBusinessId(data[0].id);
    } catch (err) {
      console.error("Error fetching businesses:", err);
    } finally {
      setLoadingBusinesses(false);
    }
  };

  const handleAnalyze = async () => {
    if (!keyword.trim() || !location.trim() || !selectedBusinessId) return;
    setLoading(true);
    setError("");
    setResult(null);

    try {
      // Call the Railway NLP service
      const response = await fetch(`${NLP_SERVICE_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({ keyword: keyword.trim(), location: location.trim() }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `Service error: ${response.status}`);
      }

      const data: AnalysisResult = await response.json();
      setResult(data);

      // Save to Supabase — upsert on (business_id, keyword, location)
      const { error: dbError } = await supabase
        .from("keyword_analyses")
        .upsert(
          {
            business_id: selectedBusinessId,
            keyword: data.keyword,
            location: data.location,
            serp_urls: data.serp_urls,
            related_keywords: data.related_keywords,
            top_quadgrams: data.top_quadgrams,
            google_entities: data.google_entities,
          },
          { onConflict: "business_id,keyword,location" }
        );

      if (dbError) console.error("Error saving analysis:", dbError);
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    const selectedBusiness = businesses.find((b) => b.id === selectedBusinessId);
    return (
      <AnalysisResultsView
        result={result}
        businessName={selectedBusiness?.business_name || ""}
        existingPages={selectedBusiness?.existing_pages || []}
        businessWebsite={selectedBusiness?.website || ""}
        onBack={() => setResult(null)}
      />
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors"
        >
          ← Back to Dashboard
        </button>
        <h1 className="text-2xl font-display font-bold text-foreground">Keyword Analysis</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Analyze competitor pages to find the right keywords, entities, and phrases for your content.
        </p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        {/* Business selector */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Business</label>
          {loadingBusinesses ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading businesses...
            </div>
          ) : businesses.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Building2 className="w-4 h-4" />
              No businesses found. Add one from Locations first.
            </div>
          ) : (
            <div className="relative">
              <select
                value={selectedBusinessId}
                onChange={(e) => setSelectedBusinessId(e.target.value)}
                className="w-full appearance-none bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.business_name} — {b.gbp_category}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>
          )}
        </div>

        {/* Primary keyword */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Primary Keyword</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="e.g. emergency plumber anaheim"
            className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Location */}
        <div className="space-y-2" ref={locationContainerRef}>
          <label className="text-sm font-medium text-foreground">Location</label>
          <p className="text-xs text-muted-foreground -mt-1">Start typing to search DataForSEO locations</p>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
            <input
              type="text"
              value={locationInput}
              onChange={(e) => handleLocationInput(e.target.value)}
              onFocus={() => { if (locationSuggestions.length > 0) setShowSuggestions(true); }}
              placeholder="e.g. Anaheim, California, United States"
              className="w-full bg-background border border-input rounded-lg pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {locationLoading && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
            )}
            {showSuggestions && locationSuggestions.length > 0 && (
              <ul className="absolute z-50 w-full mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-56 overflow-y-auto">
                {locationSuggestions.map((loc) => (
                  <li
                    key={loc}
                    onMouseDown={() => selectLocation(loc)}
                    className="px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer"
                  >
                    {loc}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Analyze button */}
        <Button
          className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
          onClick={handleAnalyze}
          disabled={loading || !keyword.trim() || !location || !selectedBusinessId || businesses.length === 0}
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing competitors...</>
          ) : (
            <><Sparkles className="w-4 h-4 mr-2" /> Run Analysis</>
          )}
        </Button>

        {loading && (
          <p className="text-xs text-center text-muted-foreground">
            Fetching SERP results, scraping competitor pages, and running NLP analysis. This takes 20–40 seconds.
          </p>
        )}
      </div>
    </div>
  );
};

export default NewContentView;
