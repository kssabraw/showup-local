import { useState, useRef, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, AlertTriangle, XCircle, ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { nlp, nlpStreamDirect, InsufficientCreditsError, purchaseCreditPack } from "@/lib/nlp-client";
import { useCredits, useInvalidateCredits } from "@/hooks/useCredits";
import type { ScoreResult, ReoptimizeResult, AnalysisResult, EngineScore } from "@/lib/nlp-types";
import CreditPackModal from "@/components/CreditPackModal";
import ImproveDiffView from "@/components/ImproveDiffView";

// Re-export for backward compat with callers that destructure the prop shape
interface GeneratedResult {
  content_html: string;
  schema_json: string;
  token_usage: ReoptimizeResult["token_usage"];
  html_css_notes?: string[];
  page_title?: string;
  cost_breakdown?: ReoptimizeResult["cost_breakdown"];
}

interface Props {
  keyword: string;
  location: string;
  locationCode?: number | null;
  pageUrl: string;
  pageTitle: string;
  businessId: string;
  businessName: string;
  gbpCategory: string;
  address: string;
  phone?: string;
  differentiators?: unknown[];
  serp_analysis?: AnalysisResult;
  onSerpAnalysis?: (analysis: AnalysisResult) => void;  // called when scoring ran analysis inline
  initialScoreResult?: ScoreResult;
  onBack: () => void;
  onGenerated: (result: GeneratedResult, mode: "reoptimize", prevScore?: number) => void;
  onCreateNew: () => void;
  relatedPagePanel?: ReactNode;
}

const ENGINE_LABELS: Record<string, string> = {
  organic_ranking: "Organic Ranking",
  gbp_maps: "GBP / Maps Relevance",
  entity_establishment: "Entity Establishment",
  icp_alignment: "ICP Alignment",
  aeo_llm_retrieval: "AEO / LLM Retrieval",
  geographic_legitimacy: "Geographic Legitimacy",
  nearme_intent: "Hyperlocal / Near-Me",
};

function statusColor(score: number) {
  if (score >= 80) return "text-green-500";
  if (score >= 60) return "text-amber-500";
  return "text-red-500";
}

function statusBg(score: number) {
  if (score >= 80) return "bg-green-500";
  if (score >= 60) return "bg-amber-500";
  return "bg-red-500";
}

function StatusIcon({ score }: { score: number }) {
  if (score >= 80) return <CheckCircle className="w-4 h-4 text-green-500" />;
  if (score >= 60) return <AlertTriangle className="w-4 h-4 text-amber-500" />;
  return <XCircle className="w-4 h-4 text-red-500" />;
}

export default function PageScoreView({
  keyword, location, locationCode, pageUrl, pageTitle, businessId, businessName,
  gbpCategory, address, phone, differentiators, serp_analysis, onSerpAnalysis,
  initialScoreResult, onBack, onGenerated, onCreateNew, relatedPagePanel,
}: Props) {
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(initialScoreResult ?? null);
  const [scoring, setScoring] = useState(false);
  const [reoptimizing, setReoptimizing] = useState(false);
  const [error, setError] = useState("");
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [expandedEngines, setExpandedEngines] = useState<Set<string>>(new Set());
  const [selectedEngineKeys, setSelectedEngineKeys] = useState<Set<string>>(new Set());
  const [diffData, setDiffData] = useState<{ result: ReoptimizeResult; originalHtml: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { data: credits } = useCredits();
  const invalidateCredits = useInvalidateCredits();

  const handleCreditPurchase = async (pack: { id: "25" | "60" | "150" }) => {
    const result = await purchaseCreditPack(pack.id);
    if (result.checkout_url) {
      window.location.href = result.checkout_url;
    } else {
      setShowCreditModal(false);
      setError(result.message ?? "Payment processing is not yet available. Please check back soon.");
    }
  };

  const saveTokenUsage = async (record: Record<string, any>) => {
    await supabase.from("token_usage").insert({
      ...record,
      business_id: businessId,
      keyword,
    });
  };

  const cancelOperation = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setScoring(false);
    setReoptimizing(false);
  };

  const runScore = async () => {
    abortRef.current = new AbortController();
    setScoring(true);
    setError("");
    try {
      const data = await nlp.scorePage(
        {
          keyword,
          location,
          location_code: locationCode ?? undefined,
          page_url: pageUrl,
          business_name: businessName,
          gbp_category: gbpCategory,
          address,
          serp_analysis,
        },
        abortRef.current.signal,
      );
      setScoreResult(data);
      setSelectedEngineKeys(new Set(data.deficiencies.map(d => d.engine_key)));
      await saveTokenUsage(data.token_usage);
      invalidateCredits();
      if (data.serp_analysis && onSerpAnalysis) {
        onSerpAnalysis(data.serp_analysis);
      }
    } catch (e: any) {
      if ((e as Error).name === "AbortError") return;
      if (e instanceof InsufficientCreditsError) { setShowCreditModal(true); return; }
      setError((e as Error).message || "Scoring failed");
    } finally {
      setScoring(false);
    }
  };

  const runReoptimize = async (deficienciesToFix?: ScoreResult["deficiencies"]) => {
    if (!scoreResult) return;
    const deficiencies = deficienciesToFix ?? scoreResult.deficiencies;
    abortRef.current = new AbortController();
    setReoptimizing(true);
    setError("");
    try {
      const stream = nlpStreamDirect<ReoptimizeResult>(
        "/reoptimize-page",
        {
          keyword,
          location,
          existing_page_html: "",   // backend re-fetches from page_url
          existing_page_url: pageUrl,
          deficiencies,
          business_name: businessName,
          gbp_category: gbpCategory,
          address,
          phone,
          serp_analysis,
        },
        abortRef.current.signal,
      );
      for await (const evt of stream) {
        if ("step" in evt && evt.step === "error") throw new Error(evt.message || "Reoptimize failed");
        if ("step" in evt && evt.step === "done" && evt.result) {
          await saveTokenUsage(evt.result.token_usage);
          invalidateCredits();
          // Transition to section diff view instead of navigating away immediately
          setDiffData({
            result: evt.result,
            originalHtml: evt.result.original_html ?? "",
          });
          return;
        }
      }
      // Stream ended without done event
      await supabase.rpc("refund_failed_generation", {
        p_amount: 2, p_endpoint: "/reoptimize-page", p_business_id: businessId,
      });
    } catch (e: any) {
      if ((e as Error).name === "AbortError") return;
      if (e instanceof InsufficientCreditsError) { setShowCreditModal(true); return; }
      await supabase.rpc("refund_failed_generation", {
        p_amount: 2, p_endpoint: "/reoptimize-page", p_business_id: businessId,
      });
      setError((e as Error).message || "Reoptimize failed");
    } finally {
      setReoptimizing(false);
    }
  };

  const toggleEngine = (key: string) => {
    setExpandedEngines(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // ── Improve Mode diff view ───────────────────────────────────────────────────
  if (diffData) {
    return (
      <ImproveDiffView
        result={diffData.result}
        originalHtml={diffData.originalHtml}
        keyword={keyword}
        location={location}
        businessName={businessName}
        gbpCategory={gbpCategory}
        address={address}
        phone={phone}
        deficiencies={scoreResult?.deficiencies ?? []}
        prevScore={scoreResult?.composite_score ?? 0}
        onApply={(contentHtml, schemaJson, pageTitle, tokenUsage) => {
          onGenerated(
            { content_html: contentHtml, schema_json: schemaJson, page_title: pageTitle, token_usage: tokenUsage },
            "reoptimize",
            scoreResult?.composite_score ?? undefined,
          );
        }}
        onBack={() => setDiffData(null)}
      />
    );
  }

  return (
    <>
    {showCreditModal && (
      <CreditPackModal
        onClose={() => setShowCreditModal(false)}
        onPurchase={handleCreditPurchase}
      />
    )}
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
          ← Back
        </button>
        <h1 className="text-2xl font-display font-bold text-foreground">Page Score</h1>
        <p className="text-sm text-muted-foreground mt-1 truncate">
          <a href={pageUrl} target="_blank" rel="noopener noreferrer" className="underline">{pageUrl}</a>
        </p>
        <p className="text-xs text-muted-foreground">Keyword: <span className="font-medium">{keyword}</span></p>
      </div>

      {!scoreResult && (
        <div className="bg-card rounded-xl border border-border p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            Score this page against 7 SEO benchmarks using our proprietary data processing techniques.
          </p>
          {error && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>
          )}
          <Button
            className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
            onClick={runScore}
            disabled={scoring || (credits !== undefined && (credits?.balance ?? 0) < 1)}
            title={(credits?.balance ?? 0) < 1 ? "Insufficient credits" : undefined}
          >
            {scoring
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{serp_analysis ? "Scoring page…" : "Analyzing competitors…"}</>
              : <>Score This Page <span className="ml-2 text-xs opacity-70 font-normal">1 credit</span></>}
          </Button>
          {scoring && (
            <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
              <span className="opacity-70">{serp_analysis ? "Usually 20–40 seconds" : "Usually 2-4 minutes (includes competitor analysis)"}</span>
              <button onClick={cancelOperation} className="hover:text-destructive transition-colors">Cancel</button>
            </div>
          )}
        </div>
      )}

      {scoreResult && (
        <div className="space-y-6">
          {/* Composite score */}
          <div className="bg-card rounded-xl border border-border p-6 flex items-center gap-6">
            <div className="text-center">
              <div className={`text-6xl font-bold ${statusColor(scoreResult.composite_score)}`}>
                {scoreResult.composite_score}
              </div>
              <div className="text-xs text-muted-foreground mt-1">/ 100</div>
            </div>
            <div>
              <div className={`text-lg font-semibold capitalize ${statusColor(scoreResult.composite_score)}`}>
                {scoreResult.composite_status.replace("_", " ")}
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                {scoreResult.deficiencies.length === 0
                  ? "No improvements needed."
                  : (() => {
                      const totalIssues = scoreResult.deficiencies.reduce((n, d) => n + (d.issues?.length ?? 1), 0);
                      return `${totalIssues} SEO issue${totalIssues !== 1 ? "s" : ""} to address.`;
                    })()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Cost: ${scoreResult.token_usage.cost_usd?.toFixed(5)} ({scoreResult.token_usage.input_tokens}+{scoreResult.token_usage.output_tokens} tokens)
              </div>
            </div>
          </div>

          {/* Engine breakdown */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Engine Breakdown</h2>
            </div>
            <div className="divide-y divide-border">
              {Object.entries(ENGINE_LABELS).map(([key, label]) => {
                const eng = scoreResult.engine_scores[key];
                if (!eng) return null;
                const expanded = expandedEngines.has(key);
                const hasDetails = (eng.issues?.length || 0) + (eng.recommendations?.length || 0) > 0;
                return (
                  <div key={key}>
                    <div className="flex items-center">
                      {eng.score < 80 && (
                        <label className="pl-4 pr-1 flex items-center cursor-pointer" title="Select to fix">
                          <input
                            type="checkbox"
                            className="rounded border-border"
                            checked={selectedEngineKeys.has(key)}
                            onChange={() => setSelectedEngineKeys(prev => {
                              const next = new Set(prev);
                              next.has(key) ? next.delete(key) : next.add(key);
                              return next;
                            })}
                          />
                        </label>
                      )}
                      <button
                        className={`flex-1 px-4 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left ${eng.score >= 80 ? "pl-6" : ""}`}
                        onClick={() => hasDetails && toggleEngine(key)}
                      >
                        <StatusIcon score={eng.score} />
                        <span className="flex-1 text-sm text-foreground">{label}</span>
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${statusBg(eng.score)}`} style={{ width: `${eng.score}%` }} />
                          </div>
                          <span className={`text-sm font-semibold w-8 text-right ${statusColor(eng.score)}`}>{eng.score}</span>
                          {hasDetails && (expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />)}
                        </div>
                      </button>
                    </div>
                    {expanded && hasDetails && (
                      <div className="px-6 pb-4 space-y-3 bg-muted/20">
                        {eng.issues?.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-red-500 mb-1">Issues</p>
                            <ul className="space-y-1">
                              {eng.issues.map((iss, i) => <li key={i} className="text-xs text-muted-foreground">• {iss}</li>)}
                            </ul>
                          </div>
                        )}
                        {eng.recommendations?.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-green-500 mb-1">Recommended fixes</p>
                            <ul className="space-y-1">
                              {eng.recommendations.map((rec, i) => <li key={i} className="text-xs text-muted-foreground">→ {rec}</li>)}
                            </ul>
                          </div>
                        )}
                        {key === "icp_alignment" && eng.icp_detected && (
                          <p className="text-xs text-muted-foreground">Detected ICP: <span className="font-medium">{eng.icp_detected}</span></p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Improve Mode CTA */}
          {error && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>
          )}
          <div className="bg-card rounded-xl border border-border p-6 space-y-3">
            {scoreResult.deficiencies.length > 0 ? (
              <>
                <div>
                  <p className="text-sm font-medium text-foreground">Improve This Page</p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Select engines above to fix, or use Fix All. Changes are shown section-by-section for your review before applying.
                  </p>
                </div>
                <Button
                  className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
                  onClick={() => runReoptimize(scoreResult.deficiencies)}
                  disabled={reoptimizing || (credits !== undefined && (credits?.balance ?? 0) < 2)}
                  title={(credits?.balance ?? 0) < 2 ? "Insufficient credits" : undefined}
                >
                  {reoptimizing
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Rewriting page…</>
                    : <>Fix All Issues <span className="ml-2 text-xs opacity-70 font-normal">2 credits</span></>}
                </Button>
                {selectedEngineKeys.size > 0 && selectedEngineKeys.size < scoreResult.deficiencies.length && (
                  <Button
                    variant="outline"
                    className="w-full font-semibold py-6"
                    onClick={() => runReoptimize(scoreResult.deficiencies.filter(d => selectedEngineKeys.has(d.engine_key)))}
                    disabled={reoptimizing || (credits !== undefined && (credits?.balance ?? 0) < 2)}
                  >
                    Fix Selected ({selectedEngineKeys.size}) <span className="ml-2 text-xs opacity-70 font-normal">2 credits</span>
                  </Button>
                )}
                {reoptimizing && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                    <span className="opacity-70">Usually 2–4 minutes</span>
                    <button onClick={cancelOperation} className="hover:text-destructive transition-colors">Cancel</button>
                  </div>
                )}
                <Button
                  variant="outline"
                  className="w-full font-semibold py-6"
                  onClick={onCreateNew}
                  disabled={reoptimizing}
                >
                  Create New Page Instead <span className="ml-2 text-xs opacity-70 font-normal">2 credits</span>
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-green-500 font-medium text-center">
                  No content reoptimizations advised.
                </p>
                <Button
                  variant="outline"
                  className="w-full font-semibold py-6"
                  onClick={onCreateNew}
                >
                  Create New Page Anyway
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {relatedPagePanel}
    </div>
    </>
  );
}
