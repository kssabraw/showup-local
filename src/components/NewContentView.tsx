import { useState, useEffect } from "react";
import { MapPin, Sparkles, ChevronDown, Building2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import AnalysisResultsView from "@/components/AnalysisResultsView";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";

interface BusinessProfile {
  id: string;
  business_name: string;
  address: string;
  gbp_category: string;
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

const NewContentView = ({ onBack }: { onBack: () => void }) => {
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [location, setLocation] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingBusinesses, setLoadingBusinesses] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);

  useEffect(() => {
    fetchBusinesses();
  }, []);

  // Pre-fill location when business is selected
  useEffect(() => {
    if (selectedBusinessId) {
      const b = businesses.find((b) => b.id === selectedBusinessId);
      if (b) {
        // Extract city + state from address for location field
        const parts = b.address.split(",").map((s) => s.trim());
        // Typical format: "123 Main St, Anaheim, CA 92801"
        // We want "Anaheim, California, United States"
        if (parts.length >= 2) {
          setLocation(parts.slice(1).join(", ") + ", United States");
        }
      }
    }
  }, [selectedBusinessId, businesses]);

  const fetchBusinesses = async () => {
    try {
      const { data, error } = await supabase
        .from("business_profiles")
        .select("id, business_name, address, gbp_category")
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
        headers: { "Content-Type": "application/json" },
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
    return (
      <AnalysisResultsView
        result={result}
        businessName={businesses.find((b) => b.id === selectedBusinessId)?.business_name || ""}
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
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Location</label>
          <p className="text-xs text-muted-foreground -mt-1">Format: City, State, Country</p>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Anaheim, California, United States"
              className="w-full bg-background border border-input rounded-lg pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
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
          disabled={loading || !keyword.trim() || !location.trim() || !selectedBusinessId || businesses.length === 0}
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
