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
import { useCredits, useInvalidateCredits } from "@/hooks/useCredits";
import { nlp, nlpStream, nlpStreamDirect, InsufficientCreditsError, RankabilityLimitError, purchaseRankabilityPack, purchaseCreditPack } from "@/lib/nlp-client";
import RankabilityPackModal from "@/components/RankabilityPackModal";
import CreditPackModal from "@/components/CreditPackModal";
import type { AnalysisResult, RankabilityResult } from "@/lib/nlp-types";
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

type PageAdvisory = {
  level: "warning" | "info";
  message: string;
  suggestNew: boolean;
};

type CheckState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "found"; page: { url: string; title: string; h1?: string; isBlogPost?: boolean }; advisory?: PageAdvisory }
  | { status: "high_score"; page: { url: string; title: string; isBlogPost?: boolean }; score: number }
  | { status: "not_found" }
  | { status: "creating" };

import type { ScoreResult, TokenUsage, CostBreakdown } from "@/lib/nlp-types";

type ViewState =
  | { kind: "form" }
  | { kind: "creating" }
  | { kind: "score"; pageMatch: { url: string; title: string; h1?: string }; serpAnalysis?: AnalysisResult; initialScoreResult?: ScoreResult }
  | { kind: "generated"; mode: "generate" | "reoptimize"; contentHtml: string; schemaJson: string; pageTitle: string; htmlCssNotes?: string[]; contentGaps?: import("@/lib/nlp-types").ContentGap[]; tokenUsage: Partial<TokenUsage>; costBreakdown: Partial<CostBreakdown>; isNew?: boolean; serpAnalysis?: AnalysisResult; prevScore?: number | null; initialScore?: number | null; savedPageId?: string | null; initialSocialPosts?: { gbp: string[] } | null }
  | { kind: "analysis"; result: AnalysisResult };

// ANALYSIS_CACHE_MAX_AGE_DAYS — cached keyword analyses older than this are ignored
const ANALYSIS_CACHE_MAX_AGE_DAYS = 7;

/** Checks whether a found page URL/title/H1 are optimized for the given keyword + location. */
function analyzePageOptimization(
  url: string,
  title: string,
  h1: string | undefined,
  keyword: string,
  location: string,
): PageAdvisory | null {
  const stopWords = new Set(["near", "the", "and", "for", "in", "of", "a", "an"]);
  const serviceTokens = keyword.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !stopWords.has(t));

  const city = location.split(",")[0].trim();
  const locationTokens = city.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(t => t.length >= 3);

  const isNearMe = keyword.toLowerCase().includes("near me");
  const urlL = url.toLowerCase();
  const titleL = title.toLowerCase();
  const h1L = (h1 ?? "").toLowerCase();

  const has = (text: string, tokens: string[]) => tokens.length > 0 && tokens.some(t => text.includes(t));

  const urlHasService  = has(urlL, serviceTokens);
  const urlHasLocation = has(urlL, locationTokens);
  const titleHasService  = has(titleL, serviceTokens);
  const titleHasLocation = has(titleL, locationTokens);
  const h1HasService  = has(h1L, serviceTokens);
  const h1HasLocation = has(h1L, locationTokens);

  if (isNearMe) {
    const allPresent = urlHasService && urlHasLocation && titleHasService && titleHasLocation && h1HasService && h1HasLocation;
    if (!allPresent) {
      return {
        level: "warning",
        message: `"Near me" queries require the service and location in the URL, title, and H1. This page is likely missing one or more of these signals.`,
        suggestNew: !urlHasService || !urlHasLocation,
      };
    }
    return null;
  }

  if (!urlHasService && !urlHasLocation) {
    return {
      level: "warning",
      message: `This page's URL contains neither the service ("${keyword}") nor the location ("${city}"). It appears to be a generic page — a dedicated service + location page will perform significantly better.`,
      suggestNew: true,
    };
  }

  if (!urlHasService || !urlHasLocation) {
    const missing = !urlHasService ? `service ("${keyword}")` : `location ("${city}")`;
    const titleH1HasService  = titleHasService  || h1HasService;
    const titleH1HasLocation = titleHasLocation || h1HasLocation;
    if (titleH1HasService && titleH1HasLocation) {
      return {
        level: "info",
        message: `The URL is missing the ${missing}, but the title and H1 include both the service and location. The page may be reoptimizable.`,
        suggestNew: false,
      };
    }
    return {
      level: "warning",
      message: `The URL is missing the ${missing}, and the title/H1 are also incomplete. A dedicated "${keyword} ${city}" page will rank better.`,
      suggestNew: true,
    };
  }

  return null;
}

const NewContentView = ({ onBack, defaultLocation = "", initialKeyword, initialLocation, initialBusinessId, isOnboarding = false }: { onBack: () => void; defaultLocation?: string; initialKeyword?: string; initialLocation?: string; initialBusinessId?: string; isOnboarding?: boolean }) => {
  const { data: businesses = [], isLoading: loadingBusinesses } = useBusinessProfiles();
  const invalidateSavedPages = useInvalidateSavedPages();
  const { data: credits } = useCredits();
  const invalidateCredits = useInvalidateCredits();

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
  const [contentTab, setContentTab] = useState<"new" | "saved">("new");
  const [generateStep, setGenerateStep] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bulkCancelledRef = useRef(false);

  const [relatedPages, setRelatedPages] = useState<Array<{ keyword: string; group: string; status: string; url?: string; composite_score?: number }> | null>(null);
  const [rankability, setRankability] = useState<RankabilityResult | null>(null);
  const [rankabilityLoading, setRankabilityLoading] = useState(false);
  const [sabCity, setSabCity] = useState("");
  const [showPackModal, setShowPackModal] = useState(false);
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [selectedForCreate, setSelectedForCreate] = useState<Set<string>>(new Set());
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; currentKw: string } | null>(null);
  const [bulkPageProgress, setBulkPageProgress] = useState<{ progress: number; step: string }>({ progress: 0, step: "" });
  const [bulkElapsed, setBulkElapsed] = useState(0);
  const bulkElapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [bulkDone, setBulkDone] = useState(0);
  const [bulkFailed, setBulkFailed] = useState(0);
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
      initialScore: page.composite_score ?? null,
      savedPageId: page.id,
      initialSocialPosts: (page.social_posts as { gbp: string[] } | null) ?? null,
      contentGaps: (page.content_gaps as import("@/lib/nlp-types").ContentGap[] | null) ?? [],
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
        serp_bold_keywords: data.serp_bold_keywords ?? [],
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
      const isSab = !b.address?.trim();
      const data = await nlp.checkRankability({
        keyword: keyword.trim(),
        location: location.trim(),
        location_code: locationCode,
        gbp_category: b.gbp_category,
        business_name: b.business_name,
        business_address: b.address,
        business_review_count: b.gbp_review_count ?? null,
        business_lat: b.latitude ?? null,
        business_lng: b.longitude ?? null,
        website: b.website,
        sab_city: isSab && sabCity.trim() ? sabCity.trim() : undefined,
        gbp_place_id: b.gbp_place_id ?? undefined,
      });
      setRankability(data);
      invalidateCredits();
    } catch (e: any) {
      if (e instanceof RankabilityLimitError) {
        setShowPackModal(true);
      } else {
        setRankability({
          score: 0, verdict: "unknown", score_breakdown: {},
          has_map_pack: false, competitors: [], ranking_categories: [],
          category_match: "none", distance_ok: true,
          keyword_in_competitor_names: 0, competitor_name_examples: [],
          in_maps_results: false, maps_position: undefined, is_sab: false, sab_pack_mismatch: false,
          physical_competitors_in_pack: 0,
          message: "Could not retrieve map pack data.", match_count: 0, total_results: 0,
        });
      }
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
    const advisory = analyzePageOptimization(foundPage.url, foundPage.title, foundPage.h1, keyword.trim(), location.trim());
    setCheckState({ status: "found", page: foundPage, advisory });
  };

  const runScoreForPage = (pageToScore: { url: string; title: string; h1?: string; isBlogPost?: boolean }) => {
    setView({ kind: "score", pageMatch: pageToScore });
    setCheckState({ status: "idle" });
  };

  const handleCreateNewPage = async (kwOverride?: string) => {
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    // kwOverride may arrive as a MouseEvent if called directly as an onClick handler — ignore it
    const safeKwOverride = typeof kwOverride === "string" ? kwOverride : undefined;

    setView({ kind: "creating" });
    setCheckState({ status: "creating" });
    setGenerateProgress(0);
    setGenerateStep("Starting…");
    setElapsedSeconds(0);
    setError("");
    elapsedRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    const kw = safeKwOverride ?? keyword;
    const b = businesses.find(b => b.id === selectedBusinessId)!;
    try {
      const stream = nlpStreamDirect<import("@/lib/nlp-types").GeneratePageResult>(
        "/generate-page",
        {
          keyword: kw.trim(),
          location: location.trim(),
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
          phone: b.phone,
          website: b.website,
          hours: b.hours ? JSON.stringify(b.hours) : undefined,
          gbp_description: b.description ?? undefined,
          differentiators: b.differentiators,
          brand_voice: b.brand_voice,
          detected_icp: b.detected_icp,
          reviews: Array.isArray(b.reviews) ? b.reviews : (b.reviews ? [b.reviews] : undefined),
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
                serp_bold_keywords: genData.serp_analysis.serp_bold_keywords ?? [],
                zone_targets: genData.serp_analysis.zone_targets ?? {},
                competitor_headings: genData.serp_analysis.competitor_headings ?? [],
              },
              { onConflict: "business_id,keyword,location" },
            );
          }
          if (!genData.content_html) {
            setError("Generation returned empty content. Your credits have been refunded. Please try again.");
            setCheckState({ status: "not_found" });
            await supabase.rpc("refund_failed_generation", {
              p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
            });
            invalidateCredits();
            setView({ kind: "form" });
            return;
          }
          // Auto-save immediately so navigating away doesn't lose the page
          let autoSavedId: string | null = null;
          try {
            const { data: savedRow } = await supabase
              .from("generated_pages")
              .insert({
                business_id: selectedBusinessId,
                keyword: kw.trim(),
                location: location.trim(),
                mode: "generate",
                page_title: genData.page_title ?? null,
                content_html: genData.content_html,
                schema_json: genData.schema_json ?? null,
                composite_score: genData.composite_score ?? null,
                content_gaps: genData.content_gaps ?? [],
              })
              .select("id")
              .single();
            if (savedRow?.id) {
              autoSavedId = savedRow.id;
              invalidateSavedPages();
            }
          } catch {
            // Non-fatal — user can still manually save from the view
          }
          setView({
            kind: "generated",
            mode: "generate",
            contentHtml: genData.content_html,
            schemaJson: genData.schema_json ?? "",
            pageTitle: genData.page_title ?? "",
            tokenUsage: genData.token_usage,
            costBreakdown: genData.cost_breakdown ?? {},
            contentGaps: genData.content_gaps ?? [],
            isNew: true,
            serpAnalysis: genData.serp_analysis ?? undefined,
            initialScore: genData.composite_score ?? null,
            savedPageId: autoSavedId,
          });
          return;
        }
      }
      // Stream ended without done event — refund and show error
      await supabase.rpc("refund_failed_generation", {
        p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
      });
      invalidateCredits();
      setError("Generation failed — the service may be temporarily unavailable. Your credits have been refunded. Please try again.");
      setCheckState({ status: "not_found" });
      setView({ kind: "form" });
    } catch (e: any) {
      if ((e as Error).name === "AbortError") { setView({ kind: "form" }); setCheckState({ status: "idle" }); return; }
      if (e instanceof InsufficientCreditsError) { setShowCreditModal(true); setCheckState({ status: "idle" }); setView({ kind: "form" }); return; }
      await supabase.rpc("refund_failed_generation", {
        p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
      });
      invalidateCredits();
      setError((e as Error).message || "Something went wrong");
      setCheckState({ status: "not_found" });
      setView({ kind: "form" });
    } finally {
      setLoadingLabel("");
      if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
    }
  };

  // Creates + auto-saves a page for the given keyword without navigating away (bulk flow)
  const createAndSavePage = async (kw: string, signal?: AbortSignal, onProgress?: (progress: number, step: string) => void): Promise<boolean> => {
    const b = businesses.find(b => b.id === selectedBusinessId);
    if (!b) return false;
    try {
      const stream = nlpStreamDirect<import("@/lib/nlp-types").GeneratePageResult>(
        "/generate-page",
        {
          keyword: kw.trim(),
          location: location.trim(),
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          address: b.address,
          phone: b.phone,
          website: b.website,
          hours: b.hours ? JSON.stringify(b.hours) : undefined,
          gbp_description: b.description ?? undefined,
          differentiators: b.differentiators,
          brand_voice: b.brand_voice,
          detected_icp: b.detected_icp,
          reviews: Array.isArray(b.reviews) ? b.reviews : (b.reviews ? [b.reviews] : undefined),
        },
        signal,
      );
      for await (const evt of stream) {
        if (evt.progress !== undefined && onProgress) onProgress(evt.progress, evt.message ?? "");
        if ("step" in evt && evt.step === "error") {
          console.error(`[createAndSavePage] stream error event for "${kw}":`, evt);
          await supabase.rpc("refund_failed_generation", {
            p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
          });
          return false;
        }
        if ("step" in evt && evt.step === "done" && evt.result) {
          const genData = evt.result;
          const { error: saveError, data: savedRow } = await supabase
            .from("generated_pages")
            .insert({
              business_id: selectedBusinessId,
              keyword: kw.trim(),
              location: location.trim(),
              mode: "generate",
              page_title: genData.page_title ?? kw,
              content_html: genData.content_html,
              schema_json: genData.schema_json ?? null,
              content_gaps: genData.content_gaps ?? [],
              composite_score: genData.composite_score ?? null,
              scored_at: genData.composite_score != null ? new Date().toISOString() : null,
            })
            .select("id")
            .single();
          if (saveError) {
            console.error("bulk create: failed to save page for keyword", kw, saveError);
            await supabase.rpc("refund_failed_generation", {
              p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
            });
            return false;
          }
          // If Railway didn't return a score (transient failure), score now and update
          if (genData.composite_score == null && savedRow?.id) {
            try {
              const scoreResult = await nlp.scorePage({
                keyword: kw.trim(),
                location: location.trim(),
                page_content: genData.content_html,
                business_name: b.business_name,
                gbp_category: b.gbp_category,
                address: b.address,
                serp_analysis: genData.serp_analysis as any,
              });
              if (scoreResult?.composite_score != null) {
                await supabase.from("generated_pages").update({
                  composite_score: scoreResult.composite_score,
                  composite_status: scoreResult.composite_status,
                  scored_at: new Date().toISOString(),
                }).eq("id", savedRow.id);
              }
            } catch {
              // Non-fatal — page saved without score
            }
          }
          await supabase.from("token_usage").insert({
            ...genData.token_usage,
            business_id: selectedBusinessId,
            keyword: kw,
          });
          return true;
        }
      }
      // Stream ended without a done event — refund
      console.error(`[createAndSavePage] stream ended without done event for "${kw}"`);
      await supabase.rpc("refund_failed_generation", {
        p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
      });
      return false;
    } catch (err) {
      console.error(`[createAndSavePage] caught exception for "${kw}":`, err);
      await supabase.rpc("refund_failed_generation", {
        p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
      });
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
    setBulkElapsed(0);
    setBulkPageProgress({ progress: 0, step: "" });
    bulkElapsedRef.current = setInterval(() => setBulkElapsed(s => s + 1), 1000);
    let done = 0;
    let failed = 0;
    for (let i = 0; i < queue.length; i++) {
      if (bulkCancelledRef.current) break;
      setBulkProgress({ current: i + 1, total: queue.length, currentKw: queue[i] });
      setBulkPageProgress({ progress: 0, step: "Starting…" });
      const ok = await createAndSavePage(queue[i], abortRef.current?.signal, (progress, step) => {
        setBulkPageProgress({ progress, step });
      });
      if (ok) done++; else failed++;
    }
    if (bulkElapsedRef.current) { clearInterval(bulkElapsedRef.current); bulkElapsedRef.current = null; }
    setBulkCreating(false);
    setBulkProgress(null);
    setBulkPageProgress({ progress: 0, step: "" });
    setBulkDone(done);
    setBulkFailed(failed);
    setSelectedForCreate(new Set());
    invalidateSavedPages();
  };

  const cancelBulk = () => {
    bulkCancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    if (bulkElapsedRef.current) { clearInterval(bulkElapsedRef.current); bulkElapsedRef.current = null; }
  };

  const handleScoreManualUrl = async () => {
    let u = manualUrl.trim();
    if (!u) return;
    if (!u.startsWith("http://") && !u.startsWith("https://")) u = `https://${u}`;
    setManualUrl("");
    runScoreForPage({ url: u, title: u });
  };

  const handleRelatedAction = ({
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

    // mode === "reoptimize" — navigate to score view; user scores manually from there
    if (!existingUrl) {
      setView({ kind: "form" });
      setCheckState({ status: "not_found" });
      return;
    }

    setView({ kind: "score", pageMatch: { url: existingUrl, title: existingUrl } });
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
                          <Button size="sm" variant="outline" className="text-xs h-7 px-2"
                            onClick={() => handleRelatedAction({ mode: "reoptimize", keyword: item.keyword, existingUrl: item.url })}>
                            Score →
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
            {!bulkCreating ? (
              <Button className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold"
                onClick={handleBulkCreate}>
                <Sparkles className="w-4 h-4 mr-2" />Create {selectedForCreate.size} Selected Page{selectedForCreate.size > 1 ? "s" : ""}
              </Button>
            ) : bulkProgress ? (
              <div className="space-y-2.5">
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                    <span className="truncate max-w-[220px]">{bulkProgress.currentKw}</span>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 ml-2">
                    {bulkProgress.current} / {bulkProgress.total}
                    {bulkProgress.current > 1 && bulkElapsed > 0 && (() => {
                      const avgSec = bulkElapsed / (bulkProgress.current - 1);
                      const remaining = Math.round(avgSec * (bulkProgress.total - bulkProgress.current + 1));
                      return remaining > 0 ? ` · ~${remaining >= 60 ? `${Math.round(remaining / 60)}m` : `${remaining}s`} left` : null;
                    })()}
                  </span>
                </div>
                {/* Overall pages progress */}
                <div className="space-y-1">
                  <div className="flex gap-1">
                    {Array.from({ length: bulkProgress.total }).map((_, idx) => (
                      <div key={idx} className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${idx < bulkProgress.current - 1 ? "bg-green-500" : idx === bulkProgress.current - 1 ? "bg-accent" : "bg-muted"}`} />
                    ))}
                  </div>
                </div>
                {/* Per-page progress bar */}
                <div className="space-y-1">
                  <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-accent/70 rounded-full transition-all duration-500" style={{ width: `${bulkPageProgress.progress}%` }} />
                  </div>
                  {bulkPageProgress.step && (
                    <p className="text-xs text-muted-foreground truncate">{bulkPageProgress.step}</p>
                  )}
                </div>
                <button onClick={cancelBulk} className="w-full text-xs text-muted-foreground hover:text-destructive transition-colors text-center py-0.5">
                  Cancel
                </button>
              </div>
            ) : null}
          </div>
        )}
        {(bulkDone > 0 || bulkFailed > 0) && !bulkCreating && (
          <div className="px-4 py-3 border-t border-border space-y-1">
            {bulkDone > 0 && (
              <p className="text-xs text-green-600 font-medium">{bulkDone} page{bulkDone > 1 ? "s" : ""} created and saved — <button type="button" onClick={() => setContentTab("saved")} className="underline hover:no-underline">view in Saved Pages</button>.</p>
            )}
            {bulkFailed > 0 && (
              <p className="text-xs text-destructive font-medium">{bulkFailed} page{bulkFailed > 1 ? "s" : ""} failed to save. Check console for details.</p>
            )}
          </div>
        )}
      </div>
    );
  })() : null;

  // ── Sub-view routing ───────────────────────────────────────────────────────
  if (view.kind === "creating") {
    const steps = [
      { label: "Fetching top search results",           detail: "Pulling the top ranking pages for your keyword",              done: generateProgress >= 40, active: generateProgress < 40 },
      { label: "Scraping & analysing competitor pages", detail: "Reading competitor pages to find patterns and topics",         done: generateProgress >= 65, active: generateProgress >= 15 && generateProgress < 65 },
      { label: "Generating page",                       detail: "AEO, SEO, CRO + JSON-LD schema",                       done: generateProgress >= 100, active: generateProgress >= 65 },
    ];
    const mins = Math.floor(elapsedSeconds / 60);
    const secs = elapsedSeconds % 60;
    const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">Creating Your Page</h1>
          <p className="text-muted-foreground text-sm mt-1">Hang tight — this usually takes 2-4 minutes.</p>
        </div>
        <div className="bg-card border border-border rounded-xl px-6 py-6 space-y-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">Building your page… <span className="tabular-nums">{elapsed}</span></span>
            <span className="opacity-70">Usually 2-4 minutes</span>
          </div>
          <div className="space-y-3">
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
                  <p className={`text-sm ${step.active ? "text-foreground font-medium" : step.done ? "text-muted-foreground line-through" : "text-muted-foreground"}`}>
                    {step.label}
                  </p>
                  {step.active && <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>}
                </div>
              </div>
            ))}
          </div>
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${generateProgress}%` }} />
          </div>
          {generateStep && <p className="text-xs text-muted-foreground text-center">{generateStep}</p>}
          <button onClick={cancelOperation} className="text-xs text-muted-foreground hover:text-destructive transition-colors">
            Cancel
          </button>
        </div>
        {error && <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>}
      </div>
    );
  }

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
        onGenerated={async (result, mode, prevScore) => {
          // Auto-save reoptimized page immediately
          let autoSavedId: string | null = null;
          try {
            const { data: savedRow } = await supabase
              .from("generated_pages")
              .insert({
                business_id: selectedBusinessId,
                keyword: keyword.trim(),
                location: location.trim(),
                mode,
                page_title: result.page_title ?? null,
                content_html: result.content_html,
                schema_json: result.schema_json ?? null,
                composite_score: result.composite_score ?? null,
                composite_status: result.composite_status ?? null,
                content_gaps: [],
              })
              .select("id")
              .single();
            if (savedRow?.id) {
              autoSavedId = savedRow.id;
              invalidateSavedPages();
            }
          } catch {
            // Non-fatal
          }
          setView({ kind: "generated", mode, contentHtml: result.content_html, schemaJson: result.schema_json, pageTitle: result.page_title ?? "", htmlCssNotes: result.html_css_notes, tokenUsage: result.token_usage, costBreakdown: result.cost_breakdown ?? {}, isNew: true, prevScore, savedPageId: autoSavedId });
        }}
        // Note: reoptimize flow doesn't produce content_gaps (it fixes existing content)
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
        contentGaps={view.contentGaps}
        tokenUsage={view.tokenUsage}
        costBreakdown={view.costBreakdown}
        businessId={selectedBusinessId}
        businessName={selectedBusiness?.business_name || ""}
        website={selectedBusiness?.website ?? undefined}
        gbpCategory={selectedBusiness?.gbp_category || ""}
        address={selectedBusiness?.address || ""}
        phone={selectedBusiness?.phone ?? undefined}
        differentiators={selectedBusiness?.differentiators ?? undefined}
        detected_icp={selectedBusiness?.detected_icp ?? undefined}
        brand_voice={selectedBusiness?.brand_voice ?? undefined}
        serp_analysis={view.serpAnalysis ?? undefined}
        prevScore={view.prevScore ?? null}
        initialScore={view.initialScore ?? null}
        savedPageId={view.savedPageId ?? null}
        initialSocialPosts={view.initialSocialPosts ?? null}
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

  const isChecking = checkState.status === "scanning" || checkState.status === "found";

  // ── Main form ──────────────────────────────────────────────────────────────
  const handleCreditPurchase = async (pack: { id: "25" | "60" | "150" }) => {
    const result = await purchaseCreditPack(pack.id);
    if (result.checkout_url) {
      window.location.href = result.checkout_url;
    } else {
      setShowCreditModal(false);
      setError(result.message ?? "Payment processing is not yet available. Please check back soon.");
    }
  };

  const handlePurchase = async (pack: { id: "5" | "10" | "20"; checks: number }) => {
    const result = await purchaseRankabilityPack(pack.id);
    if (result.checkout_url) {
      window.location.href = result.checkout_url;
    } else {
      setShowPackModal(false);
      setError(result.message ?? "Payment processing is not yet available. Please check back soon.");
    }
  };

  return (
    <>
    {showCreditModal && (
      <CreditPackModal
        onClose={() => setShowCreditModal(false)}
        onPurchase={handleCreditPurchase}
      />
    )}
    {showPackModal && (
      <RankabilityPackModal
        onClose={() => setShowPackModal(false)}
        onPurchase={handlePurchase}
      />
    )}
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

      {/* Tab switcher — only shown outside onboarding */}
      {!isOnboarding && (
        <div className="flex gap-1 bg-muted/40 rounded-lg p-1 w-fit">
          {(["new", "saved"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setContentTab(tab)}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                contentTab === tab
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "new" ? "New Page" : "Saved Pages"}
            </button>
          ))}
        </div>
      )}

      {contentTab === "saved" && !isOnboarding ? (
        <SavedPagesList businesses={businesses} onOpen={(page) => { openSavedPage(page); setContentTab("new"); }} />
      ) : (

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
            {checkState.advisory && (
              <div className={`px-3 py-2.5 rounded-lg text-xs space-y-2 ${checkState.advisory.level === "warning" ? "bg-red-500/10 border border-red-500/20 text-red-700" : "bg-blue-500/10 border border-blue-500/20 text-blue-700"}`}>
                <p>{checkState.advisory.level === "warning" ? "⚠️ " : "ℹ️ "}{checkState.advisory.message}</p>
                {checkState.advisory.suggestNew && (
                  <Button
                    className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold"
                    onClick={() => handleCreateNewPage()}
                    size="sm"
                  >
                    <FilePlus className="w-3.5 h-3.5 mr-1.5" />
                    Create a New Optimized Page
                  </Button>
                )}
              </div>
            )}
            {(!checkState.advisory || !checkState.advisory.suggestNew) && (
              <Button
                className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
                onClick={() => runScoreForPage(checkState.page)}
              >
                View & Score This Page
              </Button>
            )}
            {checkState.advisory?.suggestNew && (
              <Button
                variant="outline"
                className="w-full font-medium"
                onClick={() => runScoreForPage(checkState.page)}
              >
                View & score existing page instead
              </Button>
            )}
            <div className="flex gap-2">
              <input type="url" placeholder="Or enter a different URL…" value={manualUrl}
                onChange={e => setManualUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleScoreManualUrl()}
                className="flex-1 text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-accent" />
              <Button size="sm" onClick={handleScoreManualUrl} disabled={!manualUrl.trim()}>Score →</Button>
            </div>
            <button onClick={() => setCheckState({ status: "not_found" })}
              className="w-full text-xs text-muted-foreground hover:text-foreground text-center py-1 transition-colors">
              No page exists — create a new one instead
            </button>
            {relatedPagePanel}
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
            <div className="space-y-1">
              <div className="flex gap-2">
                <input type="url" placeholder="Or score a different URL…" value={manualUrl}
                  onChange={e => setManualUrl(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleScoreManualUrl()}
                  className="flex-1 text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-accent" />
                <Button size="sm" onClick={handleScoreManualUrl} disabled={!manualUrl.trim()}>Score</Button>
              </div>
              <p className="text-xs text-muted-foreground">Scoring costs 1 credit</p>
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
            {/* Missing GBP data warnings */}
            {selectedBusiness && (() => {
              const missing = [];
              if (!selectedBusiness.hours) missing.push("business hours");
              if (missing.length === 0) return null;
              return (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-700">
                  <span className="mt-0.5 shrink-0">⚠</span>
                  <span>
                    <span className="font-medium">{missing.join(" and ")}</span> not found in this business profile — the page will still generate but may score lower. Add this info to your GBP listing to improve results.
                  </span>
                </div>
              );
            })()}

            <Button
              className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
              onClick={handleCreateNewPage}
              disabled={(credits?.balance ?? 0) < 2}
              title={(credits?.balance ?? 0) < 2 ? "Insufficient credits" : undefined}
            >
              <Sparkles className="w-4 h-4 mr-2" /> Create New Page
              <span className="ml-2 text-xs opacity-70 font-normal">2 credits</span>
            </Button>

            <div className="space-y-1">
              <div className="flex gap-2">
                <input type="url" placeholder="Or score a different URL…" value={manualUrl}
                  onChange={e => setManualUrl(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleScoreManualUrl()}
                  className="flex-1 text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-accent" />
                <Button size="sm" onClick={handleScoreManualUrl} disabled={!manualUrl.trim()}>Score</Button>
              </div>
              <p className="text-xs text-muted-foreground">Scoring costs 1 credit</p>
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
              label: "Fetching top search results",
              detail: "Pulling the top ranking pages for your keyword",
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
              label: "Generating page",
              detail: "AEO, SEO, CRO + JSON-LD schema",
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
                <span className="opacity-70">Usually 2-4 minutes</span>
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
            {/* Rankability result panel */}
            {rankability && rankability.verdict !== "unknown" && (
              <div className="rounded-lg border text-xs space-y-2.5 overflow-hidden">
                {/* Score header */}
                <div className={`px-3 py-2.5 flex items-center justify-between ${
                  rankability.verdict === "strong" ? "bg-green-500/10 border-b border-green-500/20" :
                  rankability.verdict === "moderate" ? "bg-amber-500/10 border-b border-amber-500/20" :
                  "bg-red-500/10 border-b border-red-500/20"
                }`}>
                  <div>
                    <p className={`font-semibold ${
                      rankability.verdict === "strong" ? "text-green-700" :
                      rankability.verdict === "moderate" ? "text-amber-700" :
                      "text-red-700"
                    }`}>
                      {rankability.verdict === "strong" ? "✓ Strong rankability" :
                       rankability.verdict === "moderate" ? "⚠ Moderate — achievable with work" :
                       rankability.verdict === "difficult" ? "✗ Difficult — real barriers present" :
                       "✗ Very difficult — consider a different keyword"}
                    </p>
                    <p className="text-muted-foreground mt-0.5">{rankability.message}</p>
                  </div>
                  <div className={`text-2xl font-bold tabular-nums ml-3 flex-shrink-0 ${
                    rankability.verdict === "strong" ? "text-green-600" :
                    rankability.verdict === "moderate" ? "text-amber-600" :
                    "text-red-600"
                  }`}>{rankability.score}</div>
                </div>

                {/* Score breakdown */}
                <div className="px-3 space-y-1.5">
                  {[
                    { label: "Category match", key: "category_match", max: 35 },
                    { label: "Competition barrier", key: "competition_barrier", max: 15 },
                    { label: "Distance to target city", key: "distance", max: 20 },
                    { label: "Keyword in competitor names", key: "keyword_in_competitor_names", max: 25 },
                    { label: "Appears in Google Maps", key: "in_maps_results", max: 5 },
                  ].map(({ label, key, max }) => {
                    const pts = rankability.score_breakdown[key] ?? 0;
                    return (
                      <div key={key} className="flex items-center gap-2">
                        <span className="flex-1 text-muted-foreground truncate">{label}</span>
                        <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden flex-shrink-0">
                          <div className="h-full rounded-full bg-primary/60 transition-all" style={{ width: `${(pts / max) * 100}%` }} />
                        </div>
                        <span className="w-10 text-right tabular-nums text-muted-foreground">{pts}/{max}</span>
                      </div>
                    );
                  })}
                  {rankability.sab_pack_mismatch && (
                    <div className="flex items-center gap-2 text-red-600 font-medium">
                      <span className="flex-1">SAB vs physical pack penalty</span>
                      <span className="w-10 text-right tabular-nums">{rankability.score_breakdown["sab_penalty"] ?? -40}</span>
                    </div>
                  )}
                </div>

                {/* Competitor cards */}
                {rankability.competitors.length > 0 && (
                  <div className="px-3 pb-1">
                    <p className="text-muted-foreground mb-1.5 font-medium">Map pack competitors</p>
                    <div className="space-y-1">
                      {rankability.competitors.map((c, i) => {
                        const pos = i + 1;
                        const isClient = rankability.in_maps_results && pos === rankability.maps_position;
                        const rowClass = isClient
                          ? pos <= 3
                            ? "flex items-center justify-between bg-green-500/15 border border-green-500/30 rounded px-2 py-1"
                            : "flex items-center justify-between bg-amber-500/15 border border-amber-500/30 rounded px-2 py-1"
                          : "flex items-center justify-between bg-muted/50 rounded px-2 py-1";
                        return (
                        <div key={i} className={rowClass}>
                          <span className={`truncate flex-1 font-medium ${isClient ? (pos <= 3 ? "text-green-700" : "text-amber-700") : ""}`}>{c.name}</span>
                          <div className="flex items-center gap-2 ml-2 flex-shrink-0 text-muted-foreground">
                            {c.review_count != null && <span>{c.review_count} reviews</span>}
                            {c.rating != null && <span>★ {c.rating}</span>}
                            {c.has_keyword_in_name && <span className="text-amber-600 font-semibold">KW</span>}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                    {rankability.min_reviews_in_pack != null && (
                      <div className="text-muted-foreground mt-1.5 space-y-0.5">
                        <p>
                          Reviews in pack: <span className="font-semibold text-foreground">{rankability.min_reviews_in_pack}</span> min
                          {rankability.max_reviews_in_pack != null && <> · <span className="font-semibold text-foreground">{rankability.max_reviews_in_pack}</span> max</>}
                          {rankability.avg_rating_in_pack != null && <> · ★ <span className="font-semibold text-foreground">{rankability.avg_rating_in_pack}</span> avg</>}
                        </p>
                        {rankability.review_gap != null && rankability.review_gap > 0 && (
                          <p className="text-amber-600">Need <span className="font-semibold">{rankability.review_gap}</span> more reviews to match weakest competitor</p>
                        )}
                        {rankability.review_gap === 0 && (
                          <p className="text-green-700">✓ Review count meets or exceeds weakest competitor</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Warnings */}
                <div className="px-3 pb-2.5 space-y-1">
                  {!rankability.has_map_pack && (
                    <p className="text-amber-600">⚠ No map pack found — low local intent keyword</p>
                  )}
                  {rankability.distance_miles != null && !rankability.distance_ok && (
                    <p className="text-red-600">✗ {rankability.distance_miles} mi from target city — proximity disadvantage</p>
                  )}
                  {rankability.distance_miles != null && rankability.distance_ok && (
                    <p className="text-green-700">✓ {rankability.distance_miles} mi from target city — good proximity</p>
                  )}
                  {rankability.keyword_in_competitor_names > 0 && (
                    <p className="text-amber-600">⚠ {rankability.keyword_in_competitor_names} competitor(s) have keyword in name: {rankability.competitor_name_examples.join(", ")}</p>
                  )}
                  {rankability.in_maps_results
                    ? <p className={
                        (rankability.maps_position ?? 0) <= 3
                          ? "text-green-700 font-semibold"
                          : "text-amber-600 font-semibold"
                      }>
                        ✓ Business appears at position {rankability.maps_position} in Google Maps top 10
                      </p>
                    : <p className="text-red-600">✗ Business not found in Google Maps top 10 for this keyword</p>
                  }
                  {rankability.category_match === "none" && (
                    <p className="text-red-600">✗ GBP category mismatch — pack uses different categories</p>
                  )}
                  {rankability.ranking_categories.length > 0 && (
                    <p className="text-muted-foreground">Pack categories: {rankability.ranking_categories.slice(0, 3).map(c => c.category).join(", ")}</p>
                  )}
                </div>
              </div>
            )}
            {rankability && rankability.verdict === "unknown" && (
              <div className="px-3 py-2.5 rounded-lg text-xs border bg-muted/50 text-muted-foreground">
                {rankability.message}
              </div>
            )}
            {selectedBusiness && !selectedBusiness.address?.trim() && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Service area business detected — enter the city where your GBP is registered to calculate proximity score:
                </p>
                <input
                  type="text"
                  placeholder="e.g. Anaheim, CA"
                  value={sabCity}
                  onChange={e => setSabCity(e.target.value)}
                  className="w-full text-sm border border-input rounded-md px-3 py-1.5 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
            <div className="flex items-center gap-2">
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

      )} {/* end contentTab === "new" conditional */}
    </div>
    </>
  );
};

export default NewContentView;
