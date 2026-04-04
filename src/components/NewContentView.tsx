import { useState, useEffect, useRef } from "react";
import { MapPin, Sparkles, ChevronDown, Building2, Loader2, FileSearch, FilePlus, PhoneCall, FileText, Trash2, CheckCircle2, PlusCircle, Download } from "lucide-react";
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
  competitor_headings: any[];
}

type CheckState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "found"; page: { url: string; title: string; h1?: string; isBlogPost?: boolean } }
  | { status: "scoring"; page: { url: string; title: string; h1?: string; isBlogPost?: boolean } }
  | { status: "high_score"; page: { url: string; title: string; isBlogPost?: boolean }; score: number }
  | { status: "not_found" }
  | { status: "creating" };

type ViewState =
  | { kind: "form" }
  | { kind: "score"; pageMatch: { url: string; title: string; h1?: string }; serpAnalysis: AnalysisResult; initialScoreResult: any }
  | { kind: "generated"; mode: "generate" | "reoptimize"; contentHtml: string; schemaJson: string; pageTitle: string; htmlCssNotes?: string[]; tokenUsage: any; costBreakdown: any; isNew?: boolean }
  | { kind: "analysis"; result: AnalysisResult };

interface SavedPage {
  id: string;
  business_id: string;
  keyword: string;
  location: string;
  mode: string;
  page_title: string | null;
  content_html: string;
  schema_json: string | null;
  created_at: string;
}

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["Add business", "Generate page", "Add to website"];
  return (
    <div className="flex items-center">
      {steps.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < current;
        const active = n === current;
        return (
          <div key={n} className="flex items-center flex-1 last:flex-none">
            <div className={`flex items-center gap-1.5 shrink-0 ${active ? "text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/35"}`}>
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                done ? "bg-green-500 text-white" :
                active ? "bg-accent text-accent-foreground" :
                "border-2 border-border"
              }`}>
                {done ? "✓" : n}
              </div>
              <span className="text-xs whitespace-nowrap">{label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-px mx-3 ${done ? "bg-green-500/30" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

const NewContentView = ({ onBack, defaultLocation = "", initialKeyword, initialLocation, initialBusinessId, isOnboarding = false }: { onBack: () => void; defaultLocation?: string; initialKeyword?: string; initialLocation?: string; initialBusinessId?: string; isOnboarding?: boolean }) => {
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState(initialKeyword ?? "");
  const [location, setLocation] = useState(initialLocation ?? defaultLocation);
  const [locationCode, setLocationCode] = useState<number | null>(null);
  const [locationInput, setLocationInput] = useState(initialLocation ?? defaultLocation);
  const [locationSuggestions, setLocationSuggestions] = useState<{ name: string; code: number }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [loadingBusinesses, setLoadingBusinesses] = useState(true);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [error, setError] = useState("");
  const [checkState, setCheckState] = useState<CheckState>({ status: "idle" });
  const [view, setView] = useState<ViewState>({ kind: "form" });
  const [creatingPhase, setCreatingPhase] = useState<"serp" | "generating">("serp");
  const [generateProgress, setGenerateProgress] = useState(0);
  const [generateStep, setGenerateStep] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bulkCancelledRef = useRef(false);

  const [savedPages, setSavedPages] = useState<SavedPage[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [relatedPages, setRelatedPages] = useState<any[] | null>(null);
  const [rankability, setRankability] = useState<{ verdict: string; message: string; match_count: number; total_results: number; ranking_categories: {category: string; count: number}[] } | null>(null);
  const [rankabilityLoading, setRankabilityLoading] = useState(false);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [selectedForCreate, setSelectedForCreate] = useState<Set<string>>(new Set());
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; currentKw: string } | null>(null);
  const [bulkDone, setBulkDone] = useState(0);
  const [manualUrl, setManualUrl] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const locationDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { fetchBusinesses(); fetchSavedPages(); }, []);

  // Pre-select business when coming from onboarding flow
  useEffect(() => {
    if (initialBusinessId && businesses.length > 0 && !selectedBusinessId) {
      setSelectedBusinessId(initialBusinessId);
    }
  }, [businesses, initialBusinessId]);

  useEffect(() => {
    if (view.kind === "form") fetchSavedPages();
  }, [view.kind]);

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
    setRelatedPages(null);
    setSelectedForCreate(new Set());
    setBulkDone(0);
    setManualUrl("");
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

  const fetchSavedPages = async () => {
    setLoadingSaved(true);
    try {
      const { data } = await supabase
        .from("generated_pages")
        .select("id, business_id, keyword, location, mode, page_title, content_html, schema_json, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      setSavedPages(data || []);
    } finally {
      setLoadingSaved(false);
    }
  };

  const deleteSavedPage = async (id: string) => {
    setConfirmDeleteId(null);
    setDeletingId(id);
    await supabase.from("generated_pages").delete().eq("id", id);
    setSavedPages(prev => prev.filter(p => p.id !== id));
    setDeletingId(null);
  };

  const openSavedPage = (page: SavedPage) => {
    setKeyword(page.keyword);
    setLocation(page.location);
    setLocationInput(page.location);
    const b = businesses.find(b => b.id === page.business_id);
    if (b) setSelectedBusinessId(b.id);
    setView({
      kind: "generated",
      mode: page.mode as "generate" | "reoptimize",
      contentHtml: page.content_html,
      schemaJson: page.schema_json ?? "",
      pageTitle: page.page_title ?? "",
      tokenUsage: {},
      costBreakdown: {},
      isNew: false,
    });
  };

  const saveTokenUsage = async (record: any) => {
    await supabase.from("token_usage").insert({ ...record, business_id: selectedBusinessId, keyword });
  };

  const cancelOperation = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    bulkCancelledRef.current = true;
    if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
    setCheckState({ status: "idle" });
    setElapsedSeconds(0);
  };

  const runAnalysisFor = async (kw: string, loc: string, locCode: number | null, signal?: AbortSignal): Promise<AnalysisResult> => {
    const response = await fetch(`${NLP_SERVICE_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
      body: JSON.stringify({ keyword: kw.trim(), location: loc.trim(), location_code: locCode }),
      signal,
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
        competitor_headings: data.competitor_headings,
      },
      { onConflict: "business_id,keyword,location" }
    );
  };

  const handleCheckRankability = async () => {
    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b || !keyword.trim() || !location) return;
    setRankabilityLoading(true);
    setRankability(null);
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/check-rankability`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({ keyword: keyword.trim(), location: location.trim(), gbp_category: b.gbp_category }),
      });
      if (!res.ok) throw new Error("Rankability check failed");
      const data = await res.json();
      setRankability(data);
    } catch {
      setRankability({ verdict: "unknown", message: "Could not retrieve map pack data.", match_count: 0, total_results: 0, ranking_categories: [] });
    } finally {
      setRankabilityLoading(false);
    }
  };

  const handleCheckSite = async () => {
    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b?.website) {
      setError("This business has no website saved. Add a website URL in the Locations section first.");
      return;
    }

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    setError("");
    setCheckState({ status: "scanning" });
    setRelatedPages(null);
    setRelatedLoading(true);

    // Step 1: Scan site for existing page + fetch related pages in parallel
    let foundPage: { url: string; title: string; h1?: string } | null = null;
    try {
      const [scanRes] = await Promise.all([
        fetch(`${NLP_SERVICE_URL}/find-page-for-keyword`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
          body: JSON.stringify({ website_url: b.website, keyword: keyword.trim(), location: location.trim() }),
          signal,
        }),
        // Fire related-pages in background; results stored separately
        fetch(`${NLP_SERVICE_URL}/related-pages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
          body: JSON.stringify({
            keyword: keyword.trim(),
            location: location.trim(),
            business_name: b.business_name,
            gbp_category: b.gbp_category,
            address: b.address,
            website: b.website,
          }),
          signal,
        }).then(r => r.json()).then(d => {
          setRelatedPages(d.items ?? []);
          setRelatedLoading(false);
        }).catch(() => {
          setRelatedLoading(false);
        }),
      ]);
      if (!scanRes.ok) {
        const d = await scanRes.json().catch(() => ({}));
        throw new Error(d.detail || `Site scan error: ${scanRes.status}`);
      }
      const scanData = await scanRes.json();
      if (scanData.found && scanData.page) {
        foundPage = { ...scanData.page, isBlogPost: scanData.is_blog_post === true };
      }
    } catch (e: any) {
      if (e.name === "AbortError") return;
      setError(e.message || "Site scan failed");
      setCheckState({ status: "idle" });
      setRelatedLoading(false);
      return;
    }

    if (!foundPage) {
      setCheckState({ status: "not_found" });
      return;
    }

    // Step 2: Pause — let user confirm or override the found page
    setCheckState({ status: "found", page: foundPage });
  };

  const runScoreForPage = async (pageToScore: { url: string; title: string; h1?: string; isBlogPost?: boolean }) => {
    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b) return;

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    setCheckState({ status: "scoring", page: pageToScore });
    setError("");
    try {
      const [serpData, scoreRes] = await Promise.all([
        runAnalysisFor(keyword, location, locationCode, signal),
        fetch(`${NLP_SERVICE_URL}/score-page`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
          body: JSON.stringify({
            keyword: keyword.trim(),
            location: location.trim(),
            page_url: pageToScore.url,
            business_name: b.business_name,
            gbp_category: b.gbp_category,
            address: b.address,
          }),
          signal,
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
        setCheckState({ status: "high_score", page: pageToScore, score: scoreData.composite_score });
      } else {
        setView({
          kind: "score",
          pageMatch: pageToScore,
          serpAnalysis: serpData,
          initialScoreResult: scoreData,
        });
        setCheckState({ status: "idle" });
      }
    } catch (e: any) {
      if (e.name === "AbortError") return;
      setError(e.message || "Scoring failed");
      setCheckState({ status: "idle" });
    }
  };

  const handleCreateNewPage = async (kwOverride?: string) => {
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    setCheckState({ status: "creating" });
    setGenerateProgress(0);
    setGenerateStep("Starting…");
    setElapsedSeconds(0);
    setError("");
    elapsedRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    const kw = kwOverride ?? keyword;
    const b = businesses.find(b => b.id === selectedBusinessId)!;
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/generate-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({
          keyword: kw.trim(),
          location: location.trim(),
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
          phone: b.phone,
          differentiators: b.differentiators,
          brand_voice: b.brand_voice,
          detected_icp: b.detected_icp,
        }),
        signal,
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || `Generation error: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let evt: any;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          if (evt.progress !== undefined) setGenerateProgress(evt.progress);
          if (evt.message) setGenerateStep(evt.message);
          if (evt.step === "error") throw new Error(evt.message || "Generation failed");
          if (evt.step === "done" && evt.result) {
            const genData = evt.result;
            await saveTokenUsage(genData.token_usage);
            // Save fresh competitor analysis to Supabase
            if (genData.serp_analysis) {
              await supabase.from("keyword_analyses").upsert(
                {
                  business_id: selectedBusinessId,
                  keyword: kw.trim(),
                  location: location.trim(),
                  serp_urls: genData.serp_analysis.serp_urls ?? [],
                  related_keywords: genData.serp_analysis.related_keywords,
                  top_quadgrams: genData.serp_analysis.top_quadgrams,
                  google_entities: genData.serp_analysis.google_entities,
                  zone_targets: genData.serp_analysis.zone_targets ?? {},
                  competitor_headings: genData.serp_analysis.competitor_headings ?? [],
                },
                { onConflict: "business_id,keyword,location" }
              );
            }
            setView({
              kind: "generated",
              mode: "generate",
              contentHtml: genData.content_html,
              schemaJson: genData.schema_json,
              pageTitle: genData.page_title ?? "",
              tokenUsage: genData.token_usage,
              costBreakdown: genData.cost_breakdown ?? {},
              isNew: true,
            });
            return;
          }
        }
      }
    } catch (e: any) {
      if (e.name === "AbortError") return;
      setError(e.message || "Something went wrong");
      setCheckState({ status: "not_found" });
    } finally {
      setLoadingLabel("");
      if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
    }
  };

  // Creates + auto-saves a page for the given keyword without navigating away
  const createAndSavePage = async (kw: string, signal?: AbortSignal): Promise<boolean> => {
    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b) return false;
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/generate-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({
          keyword: kw.trim(),
          location: location.trim(),
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
          phone: b.phone,
          differentiators: b.differentiators,
          brand_voice: b.brand_voice,
          detected_icp: b.detected_icp,
        }),
        signal,
      });
      if (!res.ok || !res.body) return false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let evt: any;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          if (evt.step === "error") return false;
          if (evt.step === "done" && evt.result) {
            const genData = evt.result;
            await supabase.from("generated_pages").upsert(
              {
                business_id: selectedBusinessId,
                keyword: kw.trim(),
                location: location.trim(),
                mode: "generate",
                page_title: genData.page_title ?? kw,
                content_html: genData.content_html,
                schema_json: genData.schema_json ?? null,
              },
              { onConflict: "business_id,keyword,location" }
            );
            await supabase.from("token_usage").insert({
              ...genData.token_usage,
              business_id: selectedBusinessId,
              keyword: kw,
            });
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  const handleBulkCreate = async () => {
    const queue = Array.from(selectedForCreate);
    if (!queue.length) return;
    abortRef.current = new AbortController();
    bulkCancelledRef.current = false;
    setBulkCreating(true);
    setBulkDone(0);
    let done = 0;
    for (let i = 0; i < queue.length; i++) {
      if (bulkCancelledRef.current) break;
      setBulkProgress({ current: i + 1, total: queue.length, currentKw: queue[i] });
      const ok = await createAndSavePage(queue[i], abortRef.current?.signal);
      if (ok) done++;
    }
    setBulkCreating(false);
    setBulkProgress(null);
    setBulkDone(done);
    setSelectedForCreate(new Set());
    fetchSavedPages();
  };

  const cancelBulk = () => {
    bulkCancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const handleScoreManualUrl = async () => {
    let u = manualUrl.trim();
    if (!u) return;
    if (!u.startsWith("http://") && !u.startsWith("https://")) u = `https://${u}`;
    setManualUrl("");
    runScoreForPage({ url: u, title: u });
  };

  const handleRelatedAction = async ({
    mode,
    keyword: relKw,
    existingUrl,
  }: { mode: "reoptimize" | "new"; keyword: string; existingUrl?: string }) => {
    setError("");

    if (mode === "new") {
      handleCreateNewPage(relKw);
      return;
    }

    setKeyword(relKw);
    setView({ kind: "form" });

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

  // ── Shared related pages panel ─────────────────────────────────────────────
  const relatedPagePanel = (relatedLoading || relatedPages) ? (() => {
    const missingItems = (relatedPages ?? []).filter(p => p.status === "missing");
    const allMissingSelected = missingItems.length > 0 && missingItems.every(p => selectedForCreate.has(p.keyword));
    return (
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <p className="text-sm font-semibold text-foreground">Related Pages</p>
          <div className="flex items-center gap-3">
            {relatedLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
            {!relatedLoading && missingItems.length > 0 && (
              <button className="text-xs text-accent underline"
                onClick={() => setSelectedForCreate(allMissingSelected ? new Set() : new Set(missingItems.map(p => p.keyword)))}>
                {allMissingSelected ? "Deselect all" : "Select all missing"}
              </button>
            )}
          </div>
        </div>
        {relatedLoading && !relatedPages && (
          <div className="px-4 py-3 text-xs text-muted-foreground">Discovering related keywords…</div>
        )}
        {relatedPages && relatedPages.length === 0 && (
          <div className="px-4 py-3 text-xs text-muted-foreground">No related pages found.</div>
        )}
        {relatedPages && relatedPages.length > 0 && (
          <div className="divide-y divide-border">
            {(["parents", "siblings", "children"] as const).map(group => {
              const items = relatedPages.filter(p => p.group === group);
              if (!items.length) return null;
              const groupLabel = group === "parents" ? "Parent Pages" : group === "siblings" ? "Sibling Pages" : "Child Pages";
              return (
                <div key={group}>
                  <div className="px-4 py-2 bg-muted/30">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{groupLabel}</p>
                  </div>
                  {items.map((item: any) => (
                    <div key={item.keyword} className="px-4 py-3 flex items-center gap-3">
                      {item.status === "missing" && (
                        <input type="checkbox" className="shrink-0 accent-accent w-4 h-4 cursor-pointer"
                          checked={selectedForCreate.has(item.keyword)}
                          onChange={e => setSelectedForCreate(prev => {
                            const next = new Set(prev);
                            e.target.checked ? next.add(item.keyword) : next.delete(item.keyword);
                            return next;
                          })} />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{item.keyword}</p>
                        {item.status === "found" && item.url && (
                          <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground underline truncate block">{item.url}</a>
                        )}
                      </div>
                      {item.status === "found" ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-xs font-semibold ${item.composite_score >= 80 ? "text-green-500" : item.composite_score >= 60 ? "text-amber-500" : "text-red-500"}`}>
                            {item.composite_score ?? "–"}
                          </span>
                          <Button size="sm" variant="outline" className="text-xs h-7 px-2"
                            onClick={() => handleRelatedAction({ mode: "reoptimize", keyword: item.keyword, existingUrl: item.url })}>
                            Reoptimize
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground shrink-0">Missing</span>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {selectedForCreate.size > 0 && (
          <div className="px-4 py-3 border-t border-border bg-muted/20 space-y-2">
            <Button className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold"
              onClick={handleBulkCreate} disabled={bulkCreating}>
              {bulkCreating && bulkProgress
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating {bulkProgress.currentKw} ({bulkProgress.current}/{bulkProgress.total})…</>
                : <><Sparkles className="w-4 h-4 mr-2" />Create {selectedForCreate.size} Selected Page{selectedForCreate.size > 1 ? "s" : ""}</>}
            </Button>
            {bulkCreating && (
              <button onClick={cancelBulk} className="w-full text-xs text-muted-foreground hover:text-destructive transition-colors text-center py-0.5">
                Cancel
              </button>
            )}
          </div>
        )}
        {bulkDone > 0 && !bulkCreating && (
          <div className="px-4 py-3 border-t border-border">
            <p className="text-xs text-green-600 font-medium">{bulkDone} page{bulkDone > 1 ? "s" : ""} created and saved — view them in Saved Pages below.</p>
          </div>
        )}
      </div>
    );
  })() : null;

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
          setView({ kind: "generated", mode, contentHtml: result.content_html, schemaJson: result.schema_json, pageTitle: result.page_title ?? "", htmlCssNotes: result.html_css_notes, tokenUsage: result.token_usage, costBreakdown: result.cost_breakdown ?? {}, isNew: true })
        }
        onCreateNew={handleCreateNewPage}
        relatedPagePanel={relatedPagePanel}
      />
    );
  }

  if (view.kind === "generated") {
    return (
      <GeneratedPageView
        keyword={keyword}
        location={location}
        mode={view.mode}
        isNew={view.isNew}
        isOnboarding={isOnboarding}
        contentHtml={view.contentHtml}
        schemaJson={view.schemaJson}
        pageTitle={view.pageTitle}
        htmlCssNotes={view.htmlCssNotes}
        tokenUsage={view.tokenUsage}
        costBreakdown={view.costBreakdown}
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

  const isChecking = checkState.status === "scanning" || checkState.status === "scoring" || checkState.status === "found";

  // ── Main form ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
          ← Back to Dashboard
        </button>
        {isOnboarding ? (
          <>
            <StepIndicator current={2} />
            <h1 className="text-2xl font-display font-bold text-foreground mt-4">
              What service do you want to rank for?
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Your business is saved. Enter a service keyword below and we'll build your first page.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-display font-bold text-foreground">Content</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Generate optimized local SEO pages for your business.
            </p>
          </>
        )}
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
            onChange={(e) => { setKeyword(e.target.value); setRankability(null); }}
            disabled={isChecking}
            placeholder="e.g. emergency plumber"
            className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </div>

        {/* Area / Location input */}
        <div className="space-y-2" ref={locationContainerRef}>
          <label className="text-sm font-medium text-foreground">Area</label>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
            <input
              type="text"
              value={locationInput}
              onChange={(e) => handleLocationInput(e.target.value)}
              onFocus={() => { if (locationSuggestions.length > 0) setShowSuggestions(true); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && locationSuggestions.length > 0) {
                  selectLocation(locationSuggestions[0]);
                }
              }}
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
          <div className="px-4 py-3 bg-muted/30 rounded-lg space-y-2">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>Scanning <span className="font-medium text-foreground">{selectedBusiness?.website}</span> for "{keyword}" pages…</span>
            </div>
            <button onClick={cancelOperation} className="text-xs text-muted-foreground hover:text-destructive transition-colors">Cancel</button>
          </div>
        )}

        {/* Found — confirm or override before scoring */}
        {checkState.status === "found" && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-600">
              <FileSearch className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">Page found:</p>
                <a href={checkState.page.url} target="_blank" rel="noopener noreferrer" className="underline break-all">{checkState.page.url}</a>
              </div>
            </div>
            {checkState.page.isBlogPost && (
              <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/20 rounded-lg text-xs text-orange-600">
                <span>⚠️ This appears to be a blog post, not a dedicated service page.</span>
              </div>
            )}
            <Button className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
              onClick={() => runScoreForPage(checkState.page)}>
              Score This Page
            </Button>
            <div className="flex gap-2">
              <input type="url" placeholder="Or enter a different URL…" value={manualUrl}
                onChange={e => setManualUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleScoreManualUrl()}
                className="flex-1 text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-accent" />
              <Button size="sm" onClick={handleScoreManualUrl} disabled={!manualUrl.trim()}>Score</Button>
            </div>
            <button onClick={() => setCheckState({ status: "not_found" })}
              className="w-full text-xs text-muted-foreground hover:text-foreground text-center py-1 transition-colors">
              No page exists — create a new one instead
            </button>
          </div>
        )}

        {/* Scoring state */}
        {checkState.status === "scoring" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-600">
              <span className="flex items-center gap-2 min-w-0">
                <FileSearch className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Found: <a href={checkState.page.url} target="_blank" rel="noopener noreferrer" className="underline font-medium">{checkState.page.title}</a></span>
              </span>
            </div>
            {checkState.page.isBlogPost && (
              <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/20 rounded-lg text-xs text-orange-600">
                <span>⚠️ This appears to be a blog post, not a service page. Consider creating a dedicated service page for this keyword.</span>
              </div>
            )}
            <div className="px-4 py-3 bg-muted/30 rounded-lg space-y-2">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>Fetching competitor data and scoring this page… <span className="opacity-60 text-xs">(usually 20–40s)</span></span>
              </div>
              <button onClick={cancelOperation} className="text-xs text-muted-foreground hover:text-destructive transition-colors">Cancel</button>
            </div>
          </div>
        )}

        {/* High score — well optimized */}
        {checkState.status === "high_score" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-600">
              <span className="flex items-center gap-2 min-w-0">
                <FileSearch className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Found: <a href={checkState.page.url} target="_blank" rel="noopener noreferrer" className="underline font-medium">{checkState.page.title}</a></span>
              </span>
            </div>
            <div className="flex gap-2">
              <input type="url" placeholder="Or score a specific URL…" value={manualUrl}
                onChange={e => setManualUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleScoreManualUrl()}
                className="flex-1 text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-accent" />
              <Button size="sm" onClick={handleScoreManualUrl} disabled={!manualUrl.trim()}>Score</Button>
            </div>
            {checkState.page.isBlogPost && (
              <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/20 rounded-lg text-xs text-orange-600">
                <span>⚠️ This appears to be a blog post, not a service page. Consider creating a dedicated service page for this keyword.</span>
              </div>
            )}
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
              <a
                href="mailto:hello@showuplocal.com?subject=Off-page%20%2B%20GBP%20Analysis%20Request"
                className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-3 hover:border-accent/40 transition-colors group"
              >
                <PhoneCall className="w-4 h-4 text-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground">Contact ShowUp Experts</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Get a full off-page + GBP analysis — <span className="font-medium text-foreground">$20/page</span>
                  </p>
                </div>
                <span className="text-xs text-accent font-medium shrink-0 group-hover:underline">Get in touch →</span>
              </a>
            </div>
            {relatedPagePanel}

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

            <div className="flex gap-2">
              <input type="url" placeholder="Or score a specific URL…" value={manualUrl}
                onChange={e => setManualUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleScoreManualUrl()}
                className="flex-1 text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-accent" />
              <Button size="sm" onClick={handleScoreManualUrl} disabled={!manualUrl.trim()}>Score</Button>
            </div>

            {relatedPagePanel}

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
          const steps = [
            {
              label: "Fetching top Google results",
              detail: "DataForSEO organic SERP",
              done: generateProgress >= 40,
              active: generateProgress < 40,
            },
            {
              label: "Scraping & analysing competitor pages",
              detail: "Reading competitor pages to find patterns and topics",
              done: generateProgress >= 65,
              active: generateProgress >= 15 && generateProgress < 65,
            },
            {
              label: "Generating page with Claude",
              detail: "13-section structure + JSON-LD schema",
              done: generateProgress >= 100,
              active: generateProgress >= 65,
            },
          ];
          const mins = Math.floor(elapsedSeconds / 60);
          const secs = elapsedSeconds % 60;
          const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          return (
            <div className="px-4 py-4 bg-muted/30 rounded-lg space-y-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">Building your page… <span className="tabular-nums">{elapsed}</span></span>
                <span className="opacity-70">Usually 60–120 seconds</span>
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
                      </div>
                      {step.active && (
                        <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-500"
                  style={{ width: `${generateProgress}%` }}
                />
              </div>
              {generateStep && <p className="text-xs text-muted-foreground text-center">{generateStep}</p>}
              <button
                onClick={cancelOperation}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors mt-1"
              >
                Cancel
              </button>
            </div>
          );
        })()}

        {/* Idle — show Check My Site button */}
        {checkState.status === "idle" && (
          <div className="space-y-2">
            {/* Rankability result banner */}
            {rankability && (
              <div className={`px-3 py-2.5 rounded-lg text-xs border space-y-1.5 ${
                rankability.verdict === "match" ? "bg-green-500/10 border-green-500/20 text-green-700" :
                rankability.verdict === "partial" ? "bg-amber-500/10 border-amber-500/20 text-amber-700" :
                "bg-red-500/10 border-red-500/20 text-red-700"
              }`}>
                <p className="font-medium">{
                  rankability.verdict === "match" ? "✓ Strong map pack rankability" :
                  rankability.verdict === "partial" ? "⚠ Partial category match" :
                  rankability.verdict === "mismatch" ? "✗ Category mismatch — unlikely to rank in Maps" :
                  "Map pack data unavailable"
                }</p>
                <p className="opacity-90">{rankability.message}</p>
                {rankability.ranking_categories.length > 0 && (
                  <p className="opacity-75">
                    Map pack categories: {rankability.ranking_categories.slice(0, 4).map(c => `${c.category} (${c.count})`).join(", ")}
                  </p>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-none text-xs h-9 px-3"
                onClick={handleCheckRankability}
                disabled={!canCheck || rankabilityLoading}
              >
                {rankabilityLoading ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Checking…</> : "Check Map Pack"}
              </Button>
              <Button
                className="flex-1 bg-accent text-accent-foreground hover:opacity-90 font-semibold"
                onClick={handleCheckSite}
                disabled={!canCheck}
              >
                <FileSearch className="w-4 h-4 mr-2" /> Check My Site
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Saved Pages ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <FileText className="w-4 h-4 text-muted-foreground" /> Saved Pages
          </h2>
          {savedPages.length > 0 && (
            <span className="text-xs text-muted-foreground">{savedPages.length} page{savedPages.length !== 1 ? "s" : ""}</span>
          )}
        </div>

        {loadingSaved && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading saved pages…
          </div>
        )}

        {!loadingSaved && savedPages.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No saved pages yet. Generate a page and click Save to store it here.
          </p>
        )}

        {!loadingSaved && savedPages.length > 0 && (
          <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
            {savedPages.map(page => {
              const biz = businesses.find(b => b.id === page.business_id);
              const relativeTime = (() => {
                const diff = Date.now() - new Date(page.created_at).getTime();
                const mins = Math.floor(diff / 60000);
                const hours = Math.floor(diff / 3600000);
                const days = Math.floor(diff / 86400000);
                if (mins < 2) return "just now";
                if (mins < 60) return `${mins}m ago`;
                if (hours < 24) return `${hours}h ago`;
                if (days < 7) return `${days}d ago`;
                return new Date(page.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
              })();
              const downloadPage = () => {
                const slug = page.keyword.replace(/\s+/g, "-").toLowerCase();
                const blob = new Blob([page.content_html], { type: "text/html" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = `${slug}.html`;
                document.body.appendChild(a); a.click();
                document.body.removeChild(a); URL.revokeObjectURL(url);
              };
              return (
                <div key={page.id} className="bg-card px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground truncate">
                          {page.page_title || page.keyword}
                        </p>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                          page.mode === "reoptimize"
                            ? "bg-blue-500/10 text-blue-600"
                            : "bg-green-500/10 text-green-600"
                        }`}>
                          {page.mode === "reoptimize" ? "Reoptimized" : "Generated"}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {page.keyword} · {page.location.split(",")[0]}
                        {biz && <> · {biz.business_name}</>}
                        <span className="ml-2 opacity-60">{relativeTime}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7 px-3"
                        onClick={() => openSavedPage(page)}
                      >
                        View
                      </Button>
                      <button
                        onClick={downloadPage}
                        className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded border border-border hover:bg-muted/40"
                        title="Download HTML"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      {confirmDeleteId === page.id ? (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">Delete?</span>
                          <button onClick={() => deleteSavedPage(page.id)} className="text-destructive font-medium hover:underline">Yes</button>
                          <button onClick={() => setConfirmDeleteId(null)} className="text-muted-foreground hover:text-foreground">No</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(page.id)}
                          disabled={deletingId === page.id}
                          className="text-muted-foreground hover:text-destructive transition-colors p-1.5 rounded"
                        >
                          {deletingId === page.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default NewContentView;
