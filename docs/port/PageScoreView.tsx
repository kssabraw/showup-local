/**
 * PageScoreView — portable "Score My Page" UI.
 *
 * Ported from ShowUP Local's PageScoreView.tsx and decoupled from Supabase /
 * credits / the NLP client via an injected `api` adapter. Renders the composite
 * score, an expandable per-engine breakdown (issues + recommendations), and an
 * optional "Improve / Fix Selected" CTA that hands the chosen deficiencies to a
 * reoptimize callback (wire it to your own pipeline, or omit it).
 *
 * Deps: react, lucide-react, Tailwind CSS (shadcn-style tokens — remap if needed).
 * See SCORE_MY_PAGE_PRD.md for the full spec.
 */
import { useState, useRef } from "react";
import { Loader2, CheckCircle, AlertTriangle, XCircle, ChevronDown, ChevronUp } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────
export interface EngineScore {
  score: number;
  issues?: string[];
  recommendations?: string[];
  icp_detected?: string;
  [k: string]: unknown;
}

export interface Deficiency {
  engine: string;
  engine_key: string;
  score: number;
  issues?: string[];
  recommendations?: string[];
}

export interface ScoreResult {
  composite_score: number;
  composite_status: string;
  engine_scores: Record<string, EngineScore>;
  deficiencies: Deficiency[];
  token_usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number; [k: string]: unknown };
  serp_analysis?: unknown;
}

export interface ScorePageInput {
  keyword: string;
  location: string;
  location_code?: number | null;
  page_url?: string;
  page_content?: string;
  business_name: string;
  gbp_category: string;
  address?: string;
  serp_analysis?: unknown;
}

export interface PageScoreApi {
  /** Run scoring (POST /score-page equivalent). */
  scorePage(input: ScorePageInput, signal?: AbortSignal): Promise<ScoreResult>;
  /** OPTIONAL — reoptimize the page from a set of deficiencies. Omit to hide the Improve CTA. */
  reoptimize?(deficiencies: Deficiency[], signal?: AbortSignal): Promise<void>;
}

export interface PageScoreViewProps {
  keyword: string;
  location: string;
  locationCode?: number | null;
  pageUrl: string;
  businessName: string;
  gbpCategory: string;
  address: string;
  serpAnalysis?: unknown;
  api: PageScoreApi;
  initialScoreResult?: ScoreResult;
  onBack?: () => void;
  onCreateNew?: () => void;          // "Create New Page Instead"
  onSerpAnalysis?: (analysis: unknown) => void;  // when scoring ran analysis inline
}

const ENGINE_LABELS: Record<string, string> = {
  organic_ranking: "Organic Ranking",
  gbp_maps: "GBP / Maps Relevance",
  entity_establishment: "Entity Establishment",
  icp_alignment: "ICP Alignment",
  aeo_llm_retrieval: "AEO / LLM Retrieval",
  geographic_legitimacy: "Geographic Legitimacy",
  nearme_intent: "Hyperlocal / Near-Me",
  serp_signal_coverage: "SERP Signal Coverage",
};

const statusColor = (s: number) => (s >= 80 ? "text-green-500" : s >= 60 ? "text-amber-500" : "text-red-500");
const statusBg = (s: number) => (s >= 80 ? "bg-green-500" : s >= 60 ? "bg-amber-500" : "bg-red-500");

const StatusIcon = ({ score }: { score: number }) =>
  score >= 80 ? <CheckCircle className="w-4 h-4 text-green-500" />
  : score >= 60 ? <AlertTriangle className="w-4 h-4 text-amber-500" />
  : <XCircle className="w-4 h-4 text-red-500" />;

// ── Component ────────────────────────────────────────────────────────────────────
export default function PageScoreView({
  keyword, location, locationCode, pageUrl, businessName, gbpCategory, address,
  serpAnalysis, api, initialScoreResult, onBack, onCreateNew, onSerpAnalysis,
}: PageScoreViewProps) {
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(initialScoreResult ?? null);
  const [scoring, setScoring] = useState(false);
  const [reoptimizing, setReoptimizing] = useState(false);
  const [error, setError] = useState("");
  const [expandedEngines, setExpandedEngines] = useState<Set<string>>(new Set());
  const [selectedEngineKeys, setSelectedEngineKeys] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

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
      const data = await api.scorePage(
        { keyword, location, location_code: locationCode ?? undefined, page_url: pageUrl, business_name: businessName, gbp_category: gbpCategory, address, serp_analysis: serpAnalysis },
        abortRef.current.signal,
      );
      setScoreResult(data);
      setSelectedEngineKeys(new Set(data.deficiencies.map((d) => d.engine_key)));
      if (data.serp_analysis && onSerpAnalysis) onSerpAnalysis(data.serp_analysis);
    } catch (e: any) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message || "Scoring failed");
    } finally {
      setScoring(false);
    }
  };

  const runReoptimize = async (deficiencies: Deficiency[]) => {
    if (!api.reoptimize) return;
    abortRef.current = new AbortController();
    setReoptimizing(true);
    setError("");
    try {
      await api.reoptimize(deficiencies, abortRef.current.signal);
    } catch (e: any) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message || "Reoptimize failed");
    } finally {
      setReoptimizing(false);
    }
  };

  const toggleEngine = (key: string) =>
    setExpandedEngines((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        {onBack && <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">← Back</button>}
        <h1 className="text-2xl font-bold text-foreground">Page Score</h1>
        <p className="text-sm text-muted-foreground mt-1 truncate">
          <a href={pageUrl} target="_blank" rel="noopener noreferrer" className="underline">{pageUrl}</a>
        </p>
        <p className="text-xs text-muted-foreground">Keyword: <span className="font-medium">{keyword}</span></p>
      </div>

      {!scoreResult && (
        <div className="bg-card rounded-xl border border-border p-6 space-y-4">
          <p className="text-sm text-muted-foreground">Score this page against 8 local-SEO engines (7 rubric-scored + 1 deterministic signal-coverage engine).</p>
          {error && <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>}
          <button
            className="w-full rounded-lg bg-accent text-accent-foreground hover:opacity-90 font-semibold py-4 disabled:opacity-50"
            onClick={runScore}
            disabled={scoring}
          >
            {scoring ? <span className="inline-flex items-center"><Loader2 className="w-4 h-4 mr-2 animate-spin" />{serpAnalysis ? "Scoring page…" : "Analyzing competitors…"}</span> : "Score This Page"}
          </button>
          {scoring && (
            <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
              <span className="opacity-70">{serpAnalysis ? "Usually 20–40 seconds" : "Usually 2–4 minutes (includes competitor analysis)"}</span>
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
              <div className={`text-6xl font-bold ${statusColor(scoreResult.composite_score)}`}>{scoreResult.composite_score}</div>
              <div className="text-xs text-muted-foreground mt-1">/ 100</div>
            </div>
            <div>
              <div className={`text-lg font-semibold capitalize ${statusColor(scoreResult.composite_score)}`}>{scoreResult.composite_status.replace(/_/g, " ")}</div>
              <div className="text-sm text-muted-foreground mt-1">
                {scoreResult.deficiencies.length === 0
                  ? "No improvements needed."
                  : `${scoreResult.deficiencies.reduce((n, d) => n + (d.issues?.length ?? 1), 0)} SEO issue(s) to address.`}
              </div>
              {scoreResult.token_usage?.cost_usd != null && (
                <div className="text-xs text-muted-foreground mt-1">
                  Cost: ${scoreResult.token_usage.cost_usd?.toFixed(5)} ({scoreResult.token_usage.input_tokens}+{scoreResult.token_usage.output_tokens} tokens)
                </div>
              )}
            </div>
          </div>

          {/* Engine breakdown */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-6 py-4 border-b border-border"><h2 className="text-sm font-semibold text-foreground">Engine Breakdown</h2></div>
            <div className="divide-y divide-border">
              {Object.entries(ENGINE_LABELS).map(([key, label]) => {
                const eng = scoreResult.engine_scores[key];
                if (!eng) return null;
                const expanded = expandedEngines.has(key);
                const hasDetails = (eng.issues?.length || 0) + (eng.recommendations?.length || 0) > 0;
                return (
                  <div key={key}>
                    <div className="flex items-center">
                      {eng.score < 80 && api.reoptimize && (
                        <label className="pl-4 pr-1 flex items-center cursor-pointer" title="Select to fix">
                          <input
                            type="checkbox"
                            className="rounded border-border"
                            checked={selectedEngineKeys.has(key)}
                            onChange={() => setSelectedEngineKeys((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; })}
                          />
                        </label>
                      )}
                      <button
                        className={`flex-1 px-4 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left ${eng.score >= 80 || !api.reoptimize ? "pl-6" : ""}`}
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
                        {(eng.issues?.length ?? 0) > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-red-500 mb-1">Issues</p>
                            <ul className="space-y-1">{eng.issues!.map((iss, i) => <li key={i} className="text-xs text-muted-foreground">• {iss}</li>)}</ul>
                          </div>
                        )}
                        {(eng.recommendations?.length ?? 0) > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-green-500 mb-1">Recommended fixes</p>
                            <ul className="space-y-1">{eng.recommendations!.map((rec, i) => <li key={i} className="text-xs text-muted-foreground">→ {rec}</li>)}</ul>
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

          {/* Improve CTA (optional) */}
          {error && <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>}
          {(api.reoptimize || onCreateNew) && (
            <div className="bg-card rounded-xl border border-border p-6 space-y-3">
              {scoreResult.deficiencies.length > 0 ? (
                <>
                  {api.reoptimize && (
                    <>
                      <div>
                        <p className="text-sm font-medium text-foreground">Improve This Page</p>
                        <p className="text-sm text-muted-foreground mt-0.5">Select engines above to fix, or use Fix All.</p>
                      </div>
                      <button className="w-full rounded-lg bg-accent text-accent-foreground hover:opacity-90 font-semibold py-4 disabled:opacity-50" onClick={() => runReoptimize(scoreResult.deficiencies)} disabled={reoptimizing}>
                        {reoptimizing ? <span className="inline-flex items-center"><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Rewriting page…</span> : "Fix All Issues"}
                      </button>
                      {selectedEngineKeys.size > 0 && selectedEngineKeys.size < scoreResult.deficiencies.length && (
                        <button className="w-full rounded-lg border border-border font-semibold py-4 hover:bg-muted disabled:opacity-50" onClick={() => runReoptimize(scoreResult.deficiencies.filter((d) => selectedEngineKeys.has(d.engine_key)))} disabled={reoptimizing}>
                          Fix Selected ({selectedEngineKeys.size})
                        </button>
                      )}
                      {reoptimizing && (
                        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                          <span className="opacity-70">Usually 2–4 minutes</span>
                          <button onClick={cancelOperation} className="hover:text-destructive transition-colors">Cancel</button>
                        </div>
                      )}
                    </>
                  )}
                  {onCreateNew && (
                    <button className="w-full rounded-lg border border-border font-semibold py-4 hover:bg-muted disabled:opacity-50" onClick={onCreateNew} disabled={reoptimizing}>Create New Page Instead</button>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm text-green-500 font-medium text-center">No content reoptimizations advised.</p>
                  {onCreateNew && <button className="w-full rounded-lg border border-border font-semibold py-4 hover:bg-muted" onClick={onCreateNew}>Create New Page Anyway</button>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
