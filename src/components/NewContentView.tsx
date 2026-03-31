import { useState, useEffect, useRef } from "react";
import { MapPin, Sparkles, ChevronDown, Building2, Loader2, FileSearch, FilePlus, PhoneCall } from "lucide-react";
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
  existing_pages: any[];
  brand_voice?: any;
  detected_icp?: any;
}

interface AnalysisResult {
  keyword: string;
  location: string;
  serp_urls: string[];
  related_keywords: { title: any[]; h1: any[]; h2_h3: any[]; body: any[] };
  top_quadgrams: any[];
  google_entities: any[];
  zone_targets: Record<string, { target: number }>;
}

type CheckState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "scoring"; page: { url: string; title: string; h1?: string } }
  | { status: "high_score"; page: { url: string; title: string }; score: number }
  | { status: "not_found" }
  | { status: "creating" };

type ViewState =
  | { kind: "form" }
  | { kind: "score"; pageMatch: { url: string; title: string; h1?: string }; serpAnalysis: AnalysisResult; initialScoreResult: any }
  | { kind: "generated"; mode: "generate" | "reoptimize"; contentHtml: string; schemaJson: string; pageTitle: string; tokenUsage: any }
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
  const [loadingLabel, setLoadingLabel] = useState("");
  const [error, setError] = useState("");
  const [checkState, setCheckState] = useState<CheckState>({ status: "idle" });
  const [view, setView] = useState<ViewState>({ kind: "form" });
  const [creatingPhase, setCreatingPhase] = useState<"serp" | "generating">("serp");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Reset check state when inputs change
  useEffect(() => {
    setCheckState({ status: "idle" });
    setError("");
  }, [keyword, location, selectedBusinessId]);

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
        .select("id, business_name, address, gbp_category, website, phone, differentiators, existing_pages, brand_voice, detected_icp")
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

  const runAnalysisFor = async (kw: string, loc: string, locCode: number | null): Promise<AnalysisResult> => {
    const response = await fetch(`${NLP_SERVICE_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
      body: JSON.stringify({ keyword: kw.trim(), location: loc.trim(), location_code: locCode }),
    });
    if (!response.ok) {
      const d = await response.json().catch(() => ({}));
      throw new Error(d.detail || `Analysis error: ${response.status}`);
    }
    return response.json();
  };

  const runAnalysis = () => runAnalysisFor(keyword, location, locationCode);

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
        zone_targets: data.zone_targets,
      },
      { onConflict: "business_id,keyword,location" }
    );
  };

  const handleCheckSite = async () => {
    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b?.website) {
      setError("This business has no website saved. Add a website URL in the Locations section first.");
      return;
    }

    setError("");
    setCheckState({ status: "scanning" });

    // Step 1: Scan site for existing page
    let foundPage: { url: string; title: string; h1?: string } | null = null;
    try {
      const scanRes = await fetch(`${NLP_SERVICE_URL}/find-page-for-keyword`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({ website_url: b.website, keyword: keyword.trim() }),
      });
      if (!scanRes.ok) {
        const d = await scanRes.json().catch(() => ({}));
        throw new Error(d.detail || `Site scan error: ${scanRes.status}`);
      }
      const scanData = await scanRes.json();
      if (scanData.found && scanData.page) {
        foundPage = scanData.page;
      }
    } catch (e: any) {
      setError(e.message || "Site scan failed");
      setCheckState({ status: "idle" });
      return;
    }

    if (!foundPage) {
      setCheckState({ status: "not_found" });
      return;
    }

    // Step 2: Page found — run SERP analysis + score-page in parallel
    setCheckState({ status: "scoring", page: foundPage });
    try {
      const [serpData, scoreRes] = await Promise.all([
        runAnalysis(),
        fetch(`${NLP_SERVICE_URL}/score-page`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
          body: JSON.stringify({
            keyword: keyword.trim(),
            location: location.trim(),
            page_url: foundPage.url,
            business_name: b.business_name,
            gbp_category: b.gbp_category,
            address: b.address,
          }),
        }),
      ]);

      if (!scoreRes.ok) {
        const d = await scoreRes.json().catch(() => ({}));
        throw new Error(d.detail || `Scoring error: ${scoreRes.status}`);
      }
      const scoreData = await scoreRes.json();
      await saveTokenUsage(scoreData.token_usage);
      await saveAnalysisToSupabase(serpData);

      if (scoreData.composite_score >= 90) {
        setCheckState({ status: "high_score", page: foundPage, score: scoreData.composite_score });
      } else {
        setView({
          kind: "score",
          pageMatch: foundPage,
          serpAnalysis: serpData,
          initialScoreResult: scoreData,
        });
        setCheckState({ status: "idle" });
      }
    } catch (e: any) {
      setError(e.message || "Scoring failed");
      setCheckState({ status: "idle" });
    }
  };

  const handleCreateNewPage = async () => {
    setCheckState({ status: "creating" });
    setCreatingPhase("serp");
    setElapsedSeconds(0);
    setError("");
    elapsedRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    try {
      const serpData = await runAnalysis();
      await saveAnalysisToSupabase(serpData);

      const b = businesses.find(b => b.id === selectedBusinessId)!;
      setCreatingPhase("generating");
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
          brand_voice: b.brand_voice,
          detected_icp: b.detected_icp,
          serp_analysis: serpData,
        }),
      });
      if (!genRes.ok) {
        const d = await genRes.json().catch(() => ({}));
        throw new Error(d.detail || `Generation error: ${genRes.status}`);
      }
      const genData = await genRes.json();
      await saveTokenUsage(genData.token_usage);
      setView({ kind: "generated", mode: "generate", contentHtml: genData.content_html, schemaJson: genData.schema_json, pageTitle: genData.page_title ?? "", tokenUsage: genData.token_usage });
    } catch (e: any) {
      setError(e.message || "Something went wrong");
      setCheckState({ status: "not_found" });
    } finally {
      setLoadingLabel("");
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    }
  };

  const handleRelatedAction = async ({
    mode,
    keyword: relKw,
    existingUrl,
  }: { mode: "reoptimize" | "new"; keyword: string; existingUrl?: string }) => {
    setKeyword(relKw);
    setView({ kind: "form" });
    setError("");

    if (mode === "new") {
      // Pre-fill keyword and show the "not found" state so user can confirm
      setCheckState({ status: "not_found" });
      return;
    }

    // mode === "reoptimize" — run analysis + score the existing page
    if (!existingUrl) {
      setCheckState({ status: "not_found" });
      return;
    }

    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b) return;

    setCheckState({ status: "scoring", page: { url: existingUrl, title: existingUrl } });
    try {
      const [serpData, scoreRes] = await Promise.all([
        runAnalysisFor(relKw, location, locationCode),
        fetch(`${NLP_SERVICE_URL}/score-page`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
          body: JSON.stringify({
            keyword: relKw.trim(),
            location: location.trim(),
            page_url: existingUrl,
            business_name: b.business_name,
            gbp_category: b.gbp_category,
            address: b.address,
          }),
        }),
      ]);

      if (!scoreRes.ok) {
        const d = await scoreRes.json().catch(() => ({}));
        throw new Error(d.detail || `Scoring error: ${scoreRes.status}`);
      }
      const scoreData = await scoreRes.json();
      await saveTokenUsage(scoreData.token_usage);
      await saveAnalysisToSupabase(serpData);

      setView({
        kind: "score",
        pageMatch: { url: existingUrl, title: existingUrl },
        serpAnalysis: serpData,
        initialScoreResult: scoreData,
      });
      setCheckState({ status: "idle" });
    } catch (e: any) {
      setError(e.message || "Failed to load page score");
      setCheckState({ status: "idle" });
    }
  };

  const selectedBusiness = businesses.find(b => b.id === selectedBusinessId);
  const canCheck = !!keyword.trim() && !!location && !!selectedBusinessId && businesses.length > 0;

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
        initialScoreResult={view.initialScoreResult}
        onBack={() => setView({ kind: "form" })}
        onGenerated={(result, mode) =>
          setView({ kind: "generated", mode, contentHtml: result.content_html, schemaJson: result.schema_json, pageTitle: result.page_title ?? "", tokenUsage: result.token_usage })
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
        pageTitle={view.pageTitle}
        tokenUsage={view.tokenUsage}
        businessId={selectedBusinessId}
        businessName={selectedBusiness?.business_name || ""}
        website={selectedBusiness?.website ?? undefined}
        gbpCategory={selectedBusiness?.gbp_category || ""}
        address={selectedBusiness?.address || ""}
        onBack={() => setView({ kind: "form" })}
        onNewPage={() => { setView({ kind: "form" }); setKeyword(""); setCheckState({ status: "idle" }); }}
        onRelatedAction={handleRelatedAction}
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

  const isChecking = checkState.status === "scanning" || checkState.status === "scoring";

  // ── Main form ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
          ← Back to Dashboard
        </button>
        <h1 className="text-2xl font-display font-bold text-foreground">Content</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Generate optimized local SEO pages for your business.
        </p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        <h2 className="text-base font-semibold text-foreground">What Service And Area Do You Want To Rank For?</h2>

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
                disabled={isChecking}
                className="w-full appearance-none bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>{b.business_name} — {b.gbp_category}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>
          )}
        </div>

        {/* Service input */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Service</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            disabled={isChecking}
            placeholder="e.g. emergency plumber"
            className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </div>

        {/* Area / Location input */}
        <div className="space-y-2" ref={locationContainerRef}>
          <label className="text-sm font-medium text-foreground">Area</label>
          <p className="text-xs text-muted-foreground -mt-1">Type to search — select from the list</p>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
            <input
              type="text"
              value={locationInput}
              onChange={(e) => handleLocationInput(e.target.value)}
              onFocus={() => { if (locationSuggestions.length > 0) setShowSuggestions(true); }}
              disabled={isChecking}
              placeholder="Search locations…"
              className={`w-full bg-background border rounded-lg pl-9 pr-8 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${location ? "border-green-500" : "border-input"}`}
            />
            {location && !isChecking && (
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

        {/* ── Action area ── */}

        {/* Scanning state */}
        {checkState.status === "scanning" && (
          <div className="flex items-center gap-3 px-4 py-3 bg-muted/30 rounded-lg text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>Scanning <span className="font-medium text-foreground">{selectedBusiness?.website}</span> for "{keyword}" pages…</span>
          </div>
        )}

        {/* Scoring state */}
        {checkState.status === "scoring" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-600">
              <FileSearch className="w-3.5 h-3.5 shrink-0" />
              <span>Found: <a href={checkState.page.url} target="_blank" rel="noopener noreferrer" className="underline font-medium">{checkState.page.title}</a></span>
            </div>
            <div className="flex items-center gap-3 px-4 py-3 bg-muted/30 rounded-lg text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>Fetching competitor data and scoring this page…</span>
            </div>
          </div>
        )}

        {/* High score — well optimized */}
        {checkState.status === "high_score" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-600">
              <FileSearch className="w-3.5 h-3.5 shrink-0" />
              <span>Found: <a href={checkState.page.url} target="_blank" rel="noopener noreferrer" className="underline font-medium">{checkState.page.title}</a></span>
            </div>
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="text-3xl font-bold text-green-500">{Math.round(checkState.score)}</div>
                <div>
                  <p className="text-sm font-semibold text-green-600">Page is well optimized</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Score: {Math.round(checkState.score)}/100</p>
                </div>
              </div>
              <p className="text-sm text-foreground">
                If this page isn't ranking, on-page reoptimization is unlikely to be the issue. There may be off-page factors, domain authority gaps, or GBP signals holding it back.
              </p>
              <div className="bg-card border border-border rounded-lg px-4 py-3 flex items-start gap-3">
                <PhoneCall className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Contact ShowUp Experts</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Get a full off-page + GBP analysis from our team — <span className="font-medium text-foreground">$20/page</span>.
                  </p>
                </div>
              </div>
            </div>
            <button
              onClick={() => setCheckState({ status: "idle" })}
              className="w-full text-sm text-muted-foreground hover:text-foreground text-center py-2 transition-colors"
            >
              ← Try a different keyword
            </button>
          </div>
        )}

        {/* Not found — recommend creating new content */}
        {checkState.status === "not_found" && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 px-3 py-2.5 bg-green-500/10 border border-green-500/20 rounded-lg text-xs text-green-600">
              <FilePlus className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>No existing page found for <span className="font-medium">"{keyword}"</span> on {selectedBusiness?.website} — creating a new page is recommended.</span>
            </div>
            <Button
              className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
              onClick={handleCreateNewPage}
            >
              <Sparkles className="w-4 h-4 mr-2" /> Create New Page
            </Button>
            <button
              onClick={() => setCheckState({ status: "idle" })}
              className="w-full text-sm text-muted-foreground hover:text-foreground text-center py-1 transition-colors"
            >
              ← Try a different keyword
            </button>
          </div>
        )}

        {/* Creating state — step tracker */}
        {checkState.status === "creating" && (() => {
          const serpDone = creatingPhase === "generating";
          // Step estimates in seconds: SERP fetch ~5s, scraping ~40s, Claude ~30s
          const STEP_ESTIMATES = [5, 40, 30];
          const TOTAL_EST = STEP_ESTIMATES.reduce((a, b) => a + b, 0);
          const steps = [
            {
              label: "Fetching top Google results",
              detail: "DataForSEO organic SERP",
              est: STEP_ESTIMATES[0],
              done: serpDone,
              active: !serpDone,
            },
            {
              label: "Scraping & analysing competitor pages",
              detail: "Up to 20 pages — TF-IDF, quadgrams, entities",
              est: STEP_ESTIMATES[1],
              done: serpDone,
              active: !serpDone,
            },
            {
              label: "Generating page with Claude",
              detail: "13-section structure + JSON-LD schema",
              est: STEP_ESTIMATES[2],
              done: false,
              active: creatingPhase === "generating",
            },
          ];
          const mins = Math.floor(elapsedSeconds / 60);
          const secs = elapsedSeconds % 60;
          const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          const remaining = Math.max(0, TOTAL_EST - elapsedSeconds);
          const remMins = Math.floor(remaining / 60);
          const remSecs = remaining % 60;
          const remLabel = remaining <= 0 ? "almost done…"
            : remMins > 0 ? `~${remMins}m ${remSecs}s remaining`
            : `~${remSecs}s remaining`;
          return (
            <div className="px-4 py-4 bg-muted/30 rounded-lg space-y-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">Building your page…</span>
                <span>{elapsed} · {remLabel}</span>
              </div>
              <div className="space-y-2">
                {steps.map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                      {step.done ? (
                        <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center">
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 10 10"><path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                      ) : step.active ? (
                        <Loader2 className="w-4 h-4 animate-spin text-accent" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border border-border" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className={`text-sm ${step.active ? "text-foreground font-medium" : step.done ? "text-muted-foreground line-through" : "text-muted-foreground"}`}>
                          {step.label}
                        </p>
                        {!step.done && (
                          <span className="text-xs text-muted-foreground shrink-0">~{step.est}s</span>
                        )}
                      </div>
                      {step.active && (
                        <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Idle — show Check My Site button */}
        {checkState.status === "idle" && (
          <Button
            className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
            onClick={handleCheckSite}
            disabled={!canCheck}
          >
            <FileSearch className="w-4 h-4 mr-2" /> Check My Site
          </Button>
        )}
      </div>
    </div>
  );
};

export default NewContentView;
