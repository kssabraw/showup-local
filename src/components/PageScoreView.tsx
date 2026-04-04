import { useState, useRef, useEffect, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, AlertTriangle, XCircle, ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";
const NLP_API_KEY = import.meta.env.VITE_NLP_API_KEY ?? "";

interface EngineScore {
  score: number;
  icp_detected?: string;
  issues: string[];
  recommendations: string[];
}

interface ScoreResult {
  composite_score: number;
  composite_status: string;
  engine_scores: Record<string, EngineScore>;
  deficiencies: Array<{
    engine: string;
    engine_key: string;
    score: number;
    issues: string[];
    recommendations: string[];
  }>;
  token_usage: Record<string, any>;
}

interface GeneratedResult {
  content_html: string;
  schema_json: string;
  token_usage: Record<string, any>;
  html_css_notes?: string[];
}

interface Props {
  keyword: string;
  location: string;
  pageUrl: string;
  pageTitle: string;
  businessId: string;
  businessName: string;
  gbpCategory: string;
  address: string;
  phone?: string;
  differentiators?: any[];
  serp_analysis?: any;
  initialScoreResult?: ScoreResult;
  onBack: () => void;
  onGenerated: (result: GeneratedResult, mode: "reoptimize") => void;
  onCreateNew: () => void;
  relatedPagePanel?: ReactNode;
}

const ENGINE_LABELS: Record<string, string> = {
  organic_ranking: "Search Ranking",
  gbp_maps: "Google Maps Relevance",
  entity_establishment: "Brand Authority",
  icp_alignment: "Customer Match",
  aeo_llm_retrieval: "AI Search Visibility",
  geographic_legitimacy: "Local Relevance",
  nearme_intent: "Near Me Searches",
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
  keyword, location, pageUrl, pageTitle, businessId, businessName,
  gbpCategory, address, phone, differentiators, serp_analysis, initialScoreResult,
  onBack, onGenerated, onCreateNew, relatedPagePanel,
}: Props) {
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(initialScoreResult ?? null);
  const [scoring, setScoring] = useState(false);
  const [reoptimizing, setReoptimizing] = useState(false);
  const [reoptimizeProgress, setReoptimizeProgress] = useState(0);
  const [reoptimizeStep, setReoptimizeStep] = useState("");
  const [error, setError] = useState("");
  const [expandedEngines, setExpandedEngines] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const saveTokenUsage = async (record: Record<string, any>) => {
    await supabase.from("token_usage").insert({
      ...record,
      business_id: businessId,
      keyword,
    });
  };

  const persistScore = async (result: ScoreResult) => {
    // Only updates rows that exist — pages scored from external URLs won't match
    await supabase
      .from("generated_pages")
      .update({
        composite_score: result.composite_score,
        composite_status: result.composite_status,
        scored_at: new Date().toISOString(),
      })
      .eq("business_id", businessId)
      .eq("keyword", keyword)
      .eq("location", location);
  };

  // Persist initial score result if the view was pre-loaded with one
  useEffect(() => {
    if (initialScoreResult) persistScore(initialScoreResult);
  }, []);

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
      const res = await fetch(`${NLP_SERVICE_URL}/score-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({
          keyword,
          location,
          page_url: pageUrl,
          business_name: businessName,
          gbp_category: gbpCategory,
          address,
          serp_analysis,
        }),
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || `Score error: ${res.status}`);
      }
      const data: ScoreResult = await res.json();
      setScoreResult(data);
      await Promise.all([saveTokenUsage(data.token_usage), persistScore(data)]);
    } catch (e: any) {
      if (e.name === "AbortError") return;
      setError(e.message || "Scoring failed");
    } finally {
      setScoring(false);
    }
  };

  const runReoptimize = async () => {
    if (!scoreResult) return;
    abortRef.current = new AbortController();
    setReoptimizing(true);
    setReoptimizeProgress(0);
    setReoptimizeStep("Starting…");
    setError("");
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/reoptimize-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({
          keyword,
          location,
          existing_page_url: pageUrl,
          deficiencies: scoreResult.deficiencies,
          business_name: businessName,
          gbp_category: gbpCategory,
          address,
          phone,
          serp_analysis,
        }),
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || `Reoptimize error: ${res.status}`);
      }
      const reader = res.body!.getReader();
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
          if (evt.progress !== undefined) setReoptimizeProgress(evt.progress);
          if (evt.message) setReoptimizeStep(evt.message);
          if (evt.step === "error") throw new Error(evt.message || "Reoptimize failed");
          if (evt.step === "done" && evt.result) {
            await saveTokenUsage(evt.result.token_usage);
            onGenerated(evt.result as GeneratedResult, "reoptimize");
            return;
          }
        }
      }
    } catch (e: any) {
      if (e.name === "AbortError") return;
      setError(e.message || "Reoptimize failed");
    } finally {
      setReoptimizing(false);
      setReoptimizeProgress(0);
      setReoptimizeStep("");
    }
  };

  const toggleEngine = (key: string) => {
    setExpandedEngines(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  return (
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
            Score this page against all 7 SEO engines using the competitor SERP data as benchmarks.
          </p>
          {error && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>
          )}
          <Button
            className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
            onClick={runScore}
            disabled={scoring}
          >
            {scoring ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Scoring page…</> : "Score This Page"}
          </Button>
          {scoring && (
            <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
              <span className="opacity-70">Usually 20–40 seconds</span>
              <button onClick={cancelOperation} className="hover:text-destructive transition-colors">Cancel</button>
            </div>
          )}
        </div>
      )}

      {scoreResult && (
        <div className="space-y-6">
          {/* Composite score */}
          <div className="bg-card rounded-xl border border-border p-6 flex items-center gap-6">
            <div className="text-center shrink-0">
              <div className={`text-6xl font-bold ${statusColor(scoreResult.composite_score)}`}>
                {scoreResult.composite_score}
              </div>
              <div className="text-xs text-muted-foreground mt-1">out of 100</div>
            </div>
            <div>
              <div className={`text-lg font-semibold ${statusColor(scoreResult.composite_score)}`}>
                {scoreResult.composite_score >= 80
                  ? "Ready to publish"
                  : scoreResult.composite_score >= 60
                  ? "Good — a few tweaks could help"
                  : scoreResult.composite_score >= 40
                  ? "Needs some work"
                  : "Needs significant improvements"}
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                {scoreResult.deficiencies.length === 0
                  ? "No improvements needed — this page is well optimised."
                  : (() => {
                      const totalIssues = scoreResult.deficiencies.reduce((n, d) => n + (d.issues?.length ?? 1), 0);
                      return `${totalIssues} area${totalIssues !== 1 ? "s" : ""} to improve. Use Reoptimize to fix them automatically.`;
                    })()}
              </div>
            </div>
          </div>

          {/* Score breakdown */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Score Breakdown</h2>
            </div>
            <div className="divide-y divide-border">
              {Object.entries(ENGINE_LABELS).map(([key, label]) => {
                const eng = scoreResult.engine_scores[key];
                if (!eng) return null;
                const expanded = expandedEngines.has(key);
                const hasDetails = (eng.issues?.length || 0) + (eng.recommendations?.length || 0) > 0;
                return (
                  <div key={key}>
                    <button
                      className="w-full px-6 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
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
                    {expanded && hasDetails && (
                      <div className="px-6 pb-4 space-y-3 bg-muted/20">
                        {eng.issues?.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-red-500 mb-1">What's missing</p>
                            <ul className="space-y-1">
                              {eng.issues.map((iss, i) => <li key={i} className="text-xs text-muted-foreground">• {iss}</li>)}
                            </ul>
                          </div>
                        )}
                        {eng.recommendations?.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-green-500 mb-1">How to fix it</p>
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

          {/* Reoptimize CTA */}
          {error && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>
          )}
          <div className="bg-card rounded-xl border border-border p-6 space-y-3">
            {scoreResult.deficiencies.length > 0 ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Let ShowUP automatically rewrite this page to fix the issues above and bring in the topics your competitors are covering.
                </p>
                <Button
                  className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
                  onClick={runReoptimize}
                  disabled={reoptimizing}
                >
                  {reoptimizing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Reoptimizing…</> : "Reoptimize This Page"}
                </Button>
                {reoptimizing && (
                  <div className="space-y-1.5">
                    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all duration-500"
                        style={{ width: `${reoptimizeProgress}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground text-center">{reoptimizeStep}</p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                      <span className="opacity-70">Usually 60–90 seconds</span>
                      <button onClick={cancelOperation} className="hover:text-destructive transition-colors">Cancel</button>
                    </div>
                  </div>
                )}
                <Button
                  variant="outline"
                  className="w-full font-semibold py-6"
                  onClick={onCreateNew}
                  disabled={reoptimizing}
                >
                  Create New Page Instead
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
  );
}
