import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, AlertTriangle, XCircle, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { nlp, InsufficientCreditsError, purchaseCreditPack } from "@/lib/nlp-client";
import { useCredits, useInvalidateCredits } from "@/hooks/useCredits";
import { useBusinessProfiles } from "@/hooks/useBusinessProfiles";
import { LocationAutocomplete } from "@/components/LocationAutocomplete";
import CreditPackModal from "@/components/CreditPackModal";
import type { ScoreResult } from "@/lib/nlp-types";

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

export default function ScoreMyPageView() {
  const { data: businesses = [], isLoading: loadingBusinesses } = useBusinessProfiles();
  const { data: credits } = useCredits();
  const invalidateCredits = useInvalidateCredits();

  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [location, setLocation] = useState("");
  const [locationInput, setLocationInput] = useState("");
  const [locationCode, setLocationCode] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState("");

  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState("");
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null);
  const [scoredUrl, setScoredUrl] = useState("");
  const [expandedEngines, setExpandedEngines] = useState<Set<string>>(new Set());
  const [showCreditModal, setShowCreditModal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const selectedBusiness = businesses.find(b => b.id === selectedBusinessId);

  const canScore =
    !!selectedBusinessId &&
    !!keyword.trim() &&
    !!location &&
    !!pageUrl.trim() &&
    !scoring;

  const handleCreditPurchase = async (pack: { id: "25" | "60" | "150" }) => {
    const result = await purchaseCreditPack(pack.id);
    if (result.checkout_url) {
      window.location.href = result.checkout_url;
    } else {
      setShowCreditModal(false);
      setError(result.message ?? "Payment processing is not yet available. Please check back soon.");
    }
  };

  const handleScore = async () => {
    if (!selectedBusiness) return;
    abortRef.current = new AbortController();
    setScoring(true);
    setError("");
    setScoreResult(null);
    try {
      const data = await nlp.scorePage(
        {
          keyword: keyword.trim(),
          location: location.trim(),
          location_code: locationCode ?? undefined,
          page_url: pageUrl.trim(),
          business_name: selectedBusiness.business_name,
          gbp_category: selectedBusiness.gbp_category,
          address: selectedBusiness.address,
        },
        abortRef.current.signal,
      );
      setScoreResult(data);
      setScoredUrl(pageUrl.trim());
      invalidateCredits();
      await supabase.from("token_usage").insert({
        ...data.token_usage,
        business_id: selectedBusinessId,
        keyword: keyword.trim(),
      });
    } catch (e: any) {
      if ((e as Error).name === "AbortError") return;
      if (e instanceof InsufficientCreditsError) { setShowCreditModal(true); return; }
      setError((e as Error).message || "Scoring failed. Please try again.");
    } finally {
      setScoring(false);
    }
  };

  const handleReset = () => {
    setScoreResult(null);
    setScoredUrl("");
    setExpandedEngines(new Set());
    setError("");
  };

  const toggleEngine = (key: string) => {
    setExpandedEngines(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  return (
    <>
      {showCreditModal && (
        <CreditPackModal
          onClose={() => setShowCreditModal(false)}
          onPurchase={handleCreditPurchase}
        />
      )}

      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">Score My Page</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Score any existing page against our 7-engine local SEO rubric.
          </p>
        </div>

        {/* Form */}
        {!scoreResult && (
          <div className="bg-card rounded-xl border border-border p-6 space-y-4">
            {/* Business selector */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Business</label>
              {loadingBusinesses ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : businesses.length === 0 ? (
                <p className="text-sm text-muted-foreground">No businesses saved. Add one from the Locations page first.</p>
              ) : (
                <select
                  value={selectedBusinessId}
                  onChange={e => setSelectedBusinessId(e.target.value)}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select a business…</option>
                  {businesses.map(b => (
                    <option key={b.id} value={b.id}>{b.business_name}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Keyword */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Target keyword</label>
              <input
                type="text"
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                placeholder="e.g. emergency plumber"
                className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Location */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Location</label>
              <LocationAutocomplete
                value={location}
                inputValue={locationInput}
                onSelect={loc => {
                  setLocation(loc.name);
                  setLocationCode(loc.code);
                  setLocationInput(loc.name);
                }}
                onInputChange={raw => {
                  setLocationInput(raw);
                  setLocation("");
                  setLocationCode(null);
                }}
                onClear={() => {
                  setLocation("");
                  setLocationCode(null);
                  setLocationInput("");
                }}
              />
            </div>

            {/* Page URL */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Page URL</label>
              <input
                type="url"
                value={pageUrl}
                onChange={e => setPageUrl(e.target.value)}
                placeholder="https://example.com/your-page"
                className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {error && (
              <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{error}</div>
            )}

            <Button
              className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
              onClick={handleScore}
              disabled={!canScore || (credits?.balance ?? 0) < 1}
              title={(credits?.balance ?? 0) < 1 ? "Insufficient credits" : undefined}
            >
              {scoring
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyzing competitors & scoring…</>
                : <>Score Page <span className="ml-2 text-xs opacity-70 font-normal">1 credit</span></>}
            </Button>
            {scoring && (
              <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                <span className="opacity-70">Usually 2–4 minutes (includes competitor analysis)</span>
                <button
                  onClick={() => { abortRef.current?.abort(); setScoring(false); }}
                  className="hover:text-destructive transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {/* Results */}
        {scoreResult && (
          <div className="space-y-6">
            {/* Scored URL + reset */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs text-muted-foreground">
                  Scored: <a href={scoredUrl} target="_blank" rel="noopener noreferrer" className="underline truncate">{scoredUrl}</a>
                </p>
                <p className="text-xs text-muted-foreground">Keyword: <span className="font-medium">{keyword}</span></p>
              </div>
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Score another page
              </button>
            </div>

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
                  {scoreResult.composite_status.replace(/_/g, " ")}
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
                          {eng.issues && eng.issues.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-foreground mb-1">Issues</p>
                              <ul className="space-y-1">
                                {eng.issues.map((issue, i) => (
                                  <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                                    <XCircle className="w-3 h-3 text-red-400 mt-0.5 shrink-0" />
                                    {issue}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {eng.recommendations && eng.recommendations.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-foreground mb-1">Recommendations</p>
                              <ul className="space-y-1">
                                {eng.recommendations.map((rec, i) => (
                                  <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                                    <CheckCircle className="w-3 h-3 text-green-400 mt-0.5 shrink-0" />
                                    {rec}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Deficiencies summary */}
            {scoreResult.deficiencies.length > 0 && (
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="px-6 py-4 border-b border-border">
                  <h2 className="text-sm font-semibold text-foreground">What to Fix</h2>
                </div>
                <div className="divide-y divide-border">
                  {scoreResult.deficiencies.map((def, i) => (
                    <div key={i} className="px-6 py-4 space-y-2">
                      <div className="flex items-center gap-2">
                        <StatusIcon score={def.score} />
                        <span className="text-sm font-medium text-foreground">{ENGINE_LABELS[def.engine_key] ?? def.engine}</span>
                        <span className={`text-xs font-semibold ml-auto ${statusColor(def.score)}`}>{def.score}/100</span>
                      </div>
                      {def.recommendations?.map((rec, j) => (
                        <p key={j} className="text-xs text-muted-foreground pl-6">{rec}</p>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
