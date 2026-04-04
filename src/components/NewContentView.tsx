import { useState, useEffect, useRef } from "react";
import { Sparkles, ChevronDown, Building2, Loader2, FileSearch, FilePlus, PhoneCall, CheckCircle2, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import AnalysisResultsView from "@/components/AnalysisResultsView";
import PageScoreView from "@/components/PageScoreView";
import GeneratedPageView from "@/components/GeneratedPageView";
import { LocationAutocomplete } from "@/components/LocationAutocomplete";
import { SavedPagesList } from "@/components/SavedPagesList";
import { StepIndicator } from "@/components/StepIndicator";
import { useBusinessProfiles } from "@/hooks/useBusinessProfiles";
import { useInvalidateSavedPages } from "@/hooks/useSavedPages";
import { nlp, nlpStream } from "@/lib/nlp-client";
import type { AnalysisResult } from "@/lib/nlp-types";
import type { SavedPage } from "@/hooks/useSavedPages";

interface BusinessProfile {
  id: string;
  business_name: string;
  address: string;
  gbp_category: string;
  website: string | null;
  phone?: string | null;
  differentiators?: unknown[];
  existing_pages: unknown[];
  brand_voice?: unknown;
  detected_icp?: unknown;
}

type CheckState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "found"; page: { url: string; title: string; h1?: string; isBlogPost?: boolean } }
  | { status: "scoring"; page: { url: string; title: string; h1?: string; isBlogPost?: boolean } }
  | { status: "high_score"; page: { url: string; title: string; isBlogPost?: boolean }; score: number }
  | { status: "not_found" }
  | { status: "creating" };

import type { ScoreResult, TokenUsage, CostBreakdown } from "@/lib/nlp-types";

type ViewState =
  | { kind: "form" }
  | { kind: "score"; pageMatch: { url: string; title: string; h1?: string }; serpAnalysis?: AnalysisResult; initialScoreResult?: ScoreResult }
  | { kind: "generated"; mode: "generate" | "reoptimize"; contentHtml: string; schemaJson: string; pageTitle: string; htmlCssNotes?: string[]; tokenUsage: Partial<TokenUsage>; costBreakdown: Partial<CostBreakdown>; isNew?: boolean }
  | { kind: "analysis"; result: AnalysisResult };

// ANALYSIS_CACHE_MAX_AGE_DAYS — cached keyword analyses older than this are ignored
const ANALYSIS_CACHE_MAX_AGE_DAYS = 7;

const NewContentView = ({ onBack, defaultLocation = "", initialKeyword, initialLocation, initialBusinessId, isOnboarding = false }: { onBack: () => void; defaultLocation?: string; initialKeyword?: string; initialLocation?: string; initialBusinessId?: string; isOnboarding?: boolean }) => {
  const { data: businesses = [], isLoading: loadingBusinesses } = useBusinessProfiles();
  const invalidateSavedPages = useInvalidateSavedPages();

  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState(initialKeyword ?? "");
  const [location, setLocation] = useState(initialLocation ?? defaultLocation);
  const [locationCode, setLocationCode] = useState<number | null>(null);
  const [locationInput, setLocationInput] = useState(initialLocation ?? defaultLocation);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [error, setError] = useState("");
  const [checkState, setCheckState] = useState<CheckState>({ status: "idle" });
  const [view, setView] = useState<ViewState>({ kind: "form" });
  const [generateProgress, setGenerateProgress] = useState(0);
  const [generateStep, setGenerateStep] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bulkCancelledRef = useRef(false);

  const [relatedPages, setRelatedPages] = useState<Array<{ keyword: string; group: string; status: string; url?: string; composite_score?: number }> | null>(null);
  const [rankability, setRankability] = useState<{ verdict: string; message: string; match_count: number; total_results: number; ranking_categories: { category: string; count: number }[] } | null>(null);
  const [rankabilityLoading, setRankabilityLoading] = useState(false);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [selectedForCreate, setSelectedForCreate] = useState<Set<string>>(new Set());
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; currentKw: string } | null>(null);
  const [bulkDone, setBulkDone] = useState(0);
  const [manualUrl, setManualUrl] = useState("");

  // Auto-select first business on initial load (or onboarding-specified business)
  useEffect(() => {
    if (businesses.length === 0 || selectedBusinessId) return;
    if (initialBusinessId && businesses.some(b => b.id === initialBusinessId)) {
      setSelectedBusinessId(initialBusinessId);
    } else {
      setSelectedBusinessId(businesses[0].id);
    }
  }, [businesses, initialBusinessId, selectedBusinessId]);

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

  const saveTokenUsage = async (record: Partial<import("@/lib/nlp-types").TokenUsage>) => {
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

  /**
   * Run keyword analysis — checks Supabase cache first.
   * If a cached result exists and is less than ANALYSIS_CACHE_MAX_AGE_DAYS old, returns it without
   * calling the NLP service (saving DataForSEO + ScrapeOwl credits).
   */
  const runAnalysisFor = async (kw: string, loc: string, locCode: number | null, signal?: AbortSignal): Promise<AnalysisResult> => {
    // Check cache
    if (selectedBusinessId) {
      const { data: cached } = await supabase
        .from("keyword_analyses")
        .select("*")
        .eq("business_id", selectedBusinessId)
        .eq("keyword", kw.trim())
        .eq("location", loc.trim())
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cached) {
        const ageMs = Date.now() - new Date(cached.updated_at).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays < ANALYSIS_CACHE_MAX_AGE_DAYS) {
          return {
            keyword: cached.keyword,
            location: cached.location,
            serp_urls: (cached.serp_urls as string[]) ?? [],
            related_keywords: (cached.related_keywords as AnalysisResult["related_keywords"]) ?? { title: [], h1: [], h2_h3: [], body: [] },
            top_quadgrams: (cached.top_quadgrams as AnalysisResult["top_quadgrams"]) ?? [],
            google_entities: (cached.google_entities as AnalysisResult["google_entities"]) ?? [],
            zone_targets: (cached.zone_targets as AnalysisResult["zone_targets"]) ?? {},
            competitor_headings: (cached.competitor_headings as AnalysisResult["competitor_headings"]) ?? [],
          };
        }
      }
    }
    return nlp.analyze({ keyword: kw.trim(), location: loc.trim(), location_code: locCode }, signal);
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
      const data = await nlp.checkRankability({
        keyword: keyword.trim(),
        location: location.trim(),
        gbp_category: b.gbp_category,
      });
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
    let foundPage: { url: string; title: string; h1?: string; isBlogPost?: boolean } | null = null;
    try {
      const [scanData] = await Promise.all([
        nlp.findPageForKeyword(
          { website_url: b.website!, keyword: keyword.trim(), location: location.trim() },
          signal,
        ),
        // Fire related-pages in background; results stored separately
        nlp.relatedPages({
          keyword: keyword.trim(),
          location: location.trim(),
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
          website: b.website,
        }, signal)
          .then(d => { setRelatedPages(d.items ?? []); setRelatedLoading(false); })
          .catch(() => { setRelatedLoading(false); }),
      ]);
      if (scanData && scanData.found && scanData.page) {
        foundPage = { ...scanData.page, isBlogPost: scanData.is_blog_post === true };
      }
    } catch (e: any) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message || "Site scan failed");
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
      const [serpData, scoreData] = await Promise.all([
        runAnalysisFor(keyword, location, locationCode, signal),
        nlp.scorePage({
          keyword: keyword.trim(),
          location: location.trim(),
          page_url: pageToScore.url,
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
        }, signal),
      ]);
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
      const stream = nlpStream<import("@/lib/nlp-types").GeneratePageResult>(
        "/generate-page",
        {
          keyword: kw.trim(),
          location: location.trim(),
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
          phone: b.phone,
          differentiators: b.differentiators,
          brand_voice: b.brand_voice,
          detected_icp: b.detected_icp,
        },
        signal,
      );
      for await (const evt of stream) {
        if (evt.progress !== undefined) setGenerateProgress(evt.progress);
        if (evt.message) setGenerateStep(evt.message);
        if ("step" in evt && evt.step === "error") throw new Error(evt.message || "Generation failed");
        if ("step" in evt && evt.step === "done" && evt.result) {
          const genData = evt.result;
          await saveTokenUsage(genData.token_usage);
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
              { onConflict: "business_id,keyword,location" },
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
    } catch (e: any) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message || "Something went wrong");
      setCheckState({ status: "not_found" });
    } finally {
      setLoadingLabel("");
      if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
    }
  };

  // Creates + auto-saves a page for the given keyword without navigating away (bulk flow)
  const createAndSavePage = async (kw: string, signal?: AbortSignal): Promise<boolean> => {
    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b) return false;
    try {
      const stream = nlpStream<import("@/lib/nlp-types").GeneratePageResult>(
        "/generate-page",
        {
          keyword: kw.trim(),
          location: location.trim(),
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
          phone: b.phone,
          differentiators: b.differentiators,
          brand_voice: b.brand_voice,
          detected_icp: b.detected_icp,
        },
        signal,
      );
      for await (const evt of stream) {
        if ("step" in evt && evt.step === "error") return false;
        if ("step" in evt && evt.step === "done" && evt.result) {
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
            { onConflict: "business_id,keyword,location" },
          );
          await supabase.from("token_usage").insert({
            ...genData.token_usage,
            business_id: selectedBusinessId,
            keyword: kw,
          });
          return true;
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
    invalidateSavedPages();
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
      const [serpData, scoreData] = await Promise.all([
        runAnalysisFor(relKw, location, locationCode),
        nlp.scorePage({
          keyword: relKw.trim(),
          location: location.trim(),
          page_url: existingUrl,
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
        }),
      ]);
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
      setError((e as Error).message || "Failed to load page score");
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
        locationCode={locationCode}
        pageUrl={view.pageMatch.url}
        pageTitle={view.pageMatch.title}
        businessId={selectedBusinessId}
        businessName={selectedBusiness?.business_name || ""}
        gbpCategory={selectedBusiness?.gbp_category || ""}
        address={selectedBusiness?.address || ""}
        phone={selectedBusiness?.phone || undefined}
        differentiators={selectedBusiness?.differentiators}
        serp_analysis={view.serpAnalysis}
        onSerpAnalysis={saveAnalysisToSupabase}
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
        <LocationAutocomplete
          value={location}
          inputValue={locationInput}
          onSelect={(loc) => {
            setLocation(loc.name);
            setLocationCode(loc.code);
            setLocationInput(loc.name);
          }}
          onInputChange={(raw) => {
            setLocationInput(raw);
            setLocation("");
            setLocationCode(null);
          }}
          onClear={() => {
            setLocation("");
            setLocationCode(null);
            setLocationInput("");
          }}
          disabled={isChecking}
        />

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
      <SavedPagesList
        businesses={businesses}
        onOpen={openSavedPage}
      />
    </div>
  );
};

export default NewContentView;
