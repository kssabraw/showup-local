import { useState, useEffect, useRef } from "react";
import { MapPin, Sparkles, ChevronDown, Building2, Loader2, FileSearch, FilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import AnalysisResultsView from "@/components/AnalysisResultsView";
import PageScoreView from "@/components/PageScoreView";
import GeneratedPageView from "@/components/GeneratedPageView";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";
const NLP_API_KEY = import.meta.env.VITE_NLP_API_KEY ?? "";

interface BusinessProfile {
  id: string;
  business_name: string;
  address: string;
  gbp_category: string;
  website: string | null;
  phone?: string | null;
  differentiators?: any[];
  reviews?: any[];
  existing_pages: any[];
}

interface AnalysisResult {
  keyword: string;
  location: string;
  serp_urls: string[];
  related_keywords: { title: any[]; h1: any[]; h2_h3: any[]; body: any[] };
  top_quadgrams: any[];
  google_entities: any[];
}

interface ExistingPageMatch {
  url: string;
  title: string;
  h1?: string;
  page_type?: string;
}

type ViewState =
  | { kind: "form" }
  | { kind: "score"; pageMatch: ExistingPageMatch; serpAnalysis: AnalysisResult }
  | { kind: "generated"; mode: "generate" | "reoptimize"; contentHtml: string; schemaJson: string; tokenUsage: any }
  | { kind: "analysis"; result: AnalysisResult };

const NewContentView = ({ onBack, defaultLocation = "" }: { onBack: () => void; defaultLocation?: string }) => {
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [locationCode, setLocationCode] = useState<number | null>(null);
  const [locationInput, setLocationInput] = useState(defaultLocation);
  const [locationSuggestions, setLocationSuggestions] = useState<{ name: string; code: number }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [loadingBusinesses, setLoadingBusinesses] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [error, setError] = useState("");
  const [existingMatch, setExistingMatch] = useState<ExistingPageMatch | null | undefined>(undefined);
  const [view, setView] = useState<ViewState>({ kind: "form" });

  const locationDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { fetchBusinesses(); }, []);

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

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (locationContainerRef.current && !locationContainerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Check existing pages whenever keyword or business changes
  useEffect(() => {
    if (!keyword.trim() || !selectedBusinessId) { setExistingMatch(undefined); return; }
    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b || !b.existing_pages?.length) { setExistingMatch(null); return; }
    const kw = keyword.toLowerCase().trim();
    const kwWords = kw.split(/\s+/);
    const match = b.existing_pages.find((p: any) => {
      const text = `${p.title || ""} ${p.h1 || ""} ${p.primary_service || ""}`.toLowerCase();
      return kwWords.every(w => text.includes(w)) ||
             (p.primary_service && kw.includes(p.primary_service.toLowerCase()));
    });
    setExistingMatch(match ? { url: match.url, title: match.title || match.url, h1: match.h1, page_type: match.page_type } : null);
  }, [keyword, selectedBusinessId, businesses]);

  const handleLocationInput = (value: string) => {
    setLocationInput(value);
    setLocation("");
    setLocationCode(null);
    setShowSuggestions(true);
    if (locationDebounce.current) clearTimeout(locationDebounce.current);
    if (value.length < 2) { setLocationSuggestions([]); return; }
    locationDebounce.current = setTimeout(async () => {
      setLocationLoading(true);
      try {
        const { data } = await supabase
          .from("location")
          .select("location_name, location_code")
          .ilike("location_name", `%${value}%`)
          .limit(8);
        setLocationSuggestions((data || []).map((r: any) => ({ name: r.location_name, code: r.location_code })));
      } finally {
        setLocationLoading(false);
      }
    }, 200);
  };

  const selectLocation = (loc: { name: string; code: number }) => {
    setLocation(loc.name);
    setLocationCode(loc.code);
    setLocationInput(loc.name);
    setLocationSuggestions([]);
    setShowSuggestions(false);
  };

  const fetchBusinesses = async () => {
    try {
      const { data, error } = await supabase
        .from("business_profiles")
        .select("id, business_name, address, gbp_category, website, phone, differentiators, reviews, existing_pages")
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

  const saveTokenUsage = async (record: any) => {
    await supabase.from("token_usage").insert({ ...record, business_id: selectedBusinessId, keyword });
  };

  const runAnalysis = async (): Promise<AnalysisResult | null> => {
    const response = await fetch(`${NLP_SERVICE_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
      body: JSON.stringify({ keyword: keyword.trim(), location: location.trim(), location_code: locationCode }),
    });
    if (!response.ok) {
      const d = await response.json().catch(() => ({}));
      throw new Error(d.detail || `Analysis error: ${response.status}`);
    }
    return response.json();
  };

  const saveAnalysisToSupabase = async (data: AnalysisResult) => {
    await supabase.from("keyword_analyses").upsert(
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
  };

  const handleScoreAndReoptimize = async () => {
    if (!existingMatch) return;
    setLoading(true);
    setError("");
    try {
      setLoadingLabel("Fetching competitor SERP data…");
      const serpData = await runAnalysis();
      if (!serpData) return;
      await saveAnalysisToSupabase(serpData);
      setView({ kind: "score", pageMatch: existingMatch, serpAnalysis: serpData });
    } catch (e: any) {
      setError(e.message || "Analysis failed");
    } finally {
      setLoading(false);
      setLoadingLabel("");
    }
  };

  const handleCreateNewPage = async () => {
    setLoading(true);
    setError("");
    try {
      setLoadingLabel("Fetching competitor SERP data…");
      const serpData = await runAnalysis();
      if (!serpData) return;
      await saveAnalysisToSupabase(serpData);

      const b = businesses.find(b => b.id === selectedBusinessId)!;
      setLoadingLabel("Generating page with Claude…");
      const genRes = await fetch(`${NLP_SERVICE_URL}/generate-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({
          keyword: keyword.trim(),
          location: location.trim(),
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
          phone: b.phone,
          differentiators: b.differentiators,
          reviews: b.reviews,
          serp_analysis: serpData,
        }),
      });
      if (!genRes.ok) {
        const d = await genRes.json().catch(() => ({}));
        throw new Error(d.detail || `Generation error: ${genRes.status}`);
      }
      const genData = await genRes.json();
      await saveTokenUsage(genData.token_usage);
      setView({ kind: "generated", mode: "generate", contentHtml: genData.content_html, schemaJson: genData.schema_json, tokenUsage: genData.token_usage });
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
      setLoadingLabel("");
    }
  };

  const selectedBusiness = businesses.find(b => b.id === selectedBusinessId);

  // ── Sub-view routing ───────────────────────────────────────────────────────
  if (view.kind === "score") {
    return (
      <PageScoreView
        keyword={keyword}
        location={location}
        pageUrl={view.pageMatch.url}
        pageTitle={view.pageMatch.title}
        businessId={selectedBusinessId}
        businessName={selectedBusiness?.business_name || ""}
        gbpCategory={selectedBusiness?.gbp_category || ""}
        address={selectedBusiness?.address || ""}
        phone={selectedBusiness?.phone || undefined}
        differentiators={selectedBusiness?.differentiators}
        serp_analysis={view.serpAnalysis}
        onBack={() => setView({ kind: "form" })}
        onGenerated={(result, mode) =>
          setView({ kind: "generated", mode, contentHtml: result.content_html, schemaJson: result.schema_json, tokenUsage: result.token_usage })
        }
      />
    );
  }

  if (view.kind === "generated") {
    return (
      <GeneratedPageView
        keyword={keyword}
        location={location}
        mode={view.mode}
        contentHtml={view.contentHtml}
        schemaJson={view.schemaJson}
        tokenUsage={view.tokenUsage}
        businessId={selectedBusinessId}
        businessName={selectedBusiness?.business_name || ""}
        onBack={() => setView({ kind: "form" })}
        onNewPage={() => { setView({ kind: "form" }); setKeyword(""); setExistingMatch(undefined); }}
      />
    );
  }

  if (view.kind === "analysis") {
    return (
      <AnalysisResultsView
        result={view.result}
        businessName={selectedBusiness?.business_name || ""}
        existingPages={selectedBusiness?.existing_pages || []}
        businessWebsite={selectedBusiness?.website || ""}
        onBack={() => setView({ kind: "form" })}
      />
    );
  }

  // ── Main form ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
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
              <Loader2 className="w-4 h-4 animate-spin" /> Loading businesses…
            </div>
          ) : businesses.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Building2 className="w-4 h-4" /> No businesses found. Add one from Locations first.
            </div>
          ) : (
            <div className="relative">
              <select
                value={selectedBusinessId}
                onChange={(e) => setSelectedBusinessId(e.target.value)}
                className="w-full appearance-none bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>{b.business_name} — {b.gbp_category}</option>
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
          {/* Existing page match indicator */}
          {keyword.trim() && existingMatch !== undefined && (
            <div className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${existingMatch ? "bg-amber-500/10 border border-amber-500/20 text-amber-600" : "bg-green-500/10 border border-green-500/20 text-green-600"}`}>
              {existingMatch ? (
                <>
                  <FileSearch className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>Existing page found: <a href={existingMatch.url} target="_blank" rel="noopener noreferrer" className="underline font-medium">{existingMatch.title}</a></span>
                </>
              ) : (
                <>
                  <FilePlus className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>No existing page found for this keyword — a new page will be generated.</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Location */}
        <div className="space-y-2" ref={locationContainerRef}>
          <label className="text-sm font-medium text-foreground">Location</label>
          <p className="text-xs text-muted-foreground -mt-1">Type to search — you must select from the list</p>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
            <input
              type="text"
              value={locationInput}
              onChange={(e) => handleLocationInput(e.target.value)}
              onFocus={() => { if (locationSuggestions.length > 0) setShowSuggestions(true); }}
              placeholder="Search locations…"
              className={`w-full bg-background border rounded-lg pl-9 pr-8 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${location ? "border-green-500" : "border-input"}`}
            />
            {location && (
              <button
                type="button"
                onMouseDown={() => { setLocation(""); setLocationCode(null); setLocationInput(""); setLocationSuggestions([]); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >×</button>
            )}
            {locationLoading && !location && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
            )}
            {showSuggestions && locationSuggestions.length > 0 && (
              <ul className="absolute z-50 w-full mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-56 overflow-y-auto">
                {locationSuggestions.map((loc) => (
                  <li
                    key={loc.code}
                    onMouseDown={() => selectLocation(loc)}
                    className="px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer"
                  >
                    {loc.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {locationInput && !location && (
            <p className="text-xs text-amber-500">Select a location from the dropdown to continue</p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>
        )}

        {/* Action buttons */}
        {existingMatch ? (
          <div className="space-y-3">
            <Button
              className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
              onClick={handleScoreAndReoptimize}
              disabled={loading || !keyword.trim() || !location || !selectedBusinessId || businesses.length === 0}
            >
              {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {loadingLabel || "Analyzing…"}</> : <><FileSearch className="w-4 h-4 mr-2" /> Score & Reoptimize Existing Page</>}
            </Button>
            <button
              onClick={handleCreateNewPage}
              disabled={loading || !keyword.trim() || !location || !selectedBusinessId}
              className="w-full text-sm text-muted-foreground hover:text-foreground text-center py-2 transition-colors disabled:opacity-50"
            >
              Skip — create a new page instead →
            </button>
          </div>
        ) : (
          <Button
            className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
            onClick={handleCreateNewPage}
            disabled={loading || !keyword.trim() || !location || !selectedBusinessId || businesses.length === 0}
          >
            {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {loadingLabel || "Analyzing…"}</> : <><Sparkles className="w-4 h-4 mr-2" /> {existingMatch === null ? "Run Analysis & Create Page" : "Run Analysis"}</>}
          </Button>
        )}

        {loading && (
          <p className="text-xs text-center text-muted-foreground">
            {loadingLabel || "Fetching SERP results, scraping competitor pages, running NLP analysis… 20–60 seconds."}
          </p>
        )}
      </div>
    </div>
  );
};

export default NewContentView;
