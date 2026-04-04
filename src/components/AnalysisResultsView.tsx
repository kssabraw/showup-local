import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Loader2, CheckCircle2, XCircle, AlertCircle, Sparkles, X } from "lucide-react";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";
const NLP_API_KEY = import.meta.env.VITE_NLP_API_KEY ?? "";

// Only allow http/https URLs in rendered links to prevent javascript: injection
const isSafeUrl = (url: string) => /^https?:\/\//i.test(url);

interface RelatedKeyword {
  term: string;
  score: number;
  page_spread: number;
  page_spread_pct: number;
  type: string;
}

interface Quadgram {
  phrase: string;
  page_spread: number;
  page_spread_pct: number;
  similarity_score: number;
  type: string;
}

interface GoogleEntity {
  name: string;
  entity_type: string;
  mean_salience: number;
  page_spread: number;
  page_spread_pct: number;
  recommended_mentions: number;
  type: string;
}

interface AnalysisResult {
  keyword: string;
  location: string;
  serp_urls: string[];
  related_keywords: {
    title: RelatedKeyword[];
    h1: RelatedKeyword[];
    h2_h3: RelatedKeyword[];
    body: RelatedKeyword[];
  };
  top_quadgrams: Quadgram[];
  google_entities: GoogleEntity[];
}

const ZONE_LABELS: Record<string, string> = {
  title: "Title Tag",
  h1: "H1",
  h2_h3: "H2 / H3",
  body: "Body",
};

const ENTITY_FRIENDLY_LABELS: Record<string, string> = {
  LOCATION: "Place",
  ORGANIZATION: "Company",
  PERSON: "Person",
  CONSUMER_GOOD: "Product",
  EVENT: "Event",
  OTHER: "Topic",
  UNKNOWN: "Topic",
};

const ENTITY_TYPE_COLORS: Record<string, string> = {
  LOCATION: "bg-blue-500/10 text-blue-600",
  ORGANIZATION: "bg-purple-500/10 text-purple-600",
  PERSON: "bg-green-500/10 text-green-600",
  CONSUMER_GOOD: "bg-orange-500/10 text-orange-600",
  EVENT: "bg-pink-500/10 text-pink-600",
  OTHER: "bg-muted text-muted-foreground",
  UNKNOWN: "bg-muted text-muted-foreground",
};

function SpreadBadge({ pct }: { pct: number }) {
  const pct100 = Math.round(pct * 100);
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent-foreground">
      {pct100}% of pages
    </span>
  );
}

function KeywordZoneTable({ keywords, zone }: { keywords: RelatedKeyword[]; zone: string }) {
  const [expanded, setExpanded] = useState(zone === "title" || zone === "h1");

  if (keywords.length === 0) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{ZONE_LABELS[zone]}</span>
          <span className="text-xs text-muted-foreground">{keywords.length} terms</span>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="divide-y divide-border">
          {keywords.map((kw, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/20 transition-colors">
              <span className="text-sm text-foreground font-medium">{kw.term}</span>
              <div className="flex items-center gap-3">
                <SpreadBadge pct={kw.page_spread_pct} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ExistingPage {
  url: string;
  title?: string;
  h1?: string;
  page_type?: string;
  primary_service?: string | null;
  primary_city?: string | null;
}

interface PageScore {
  title: string;
  h1: string;
  word_count: number;
  score: number;
  keyword_in_title: boolean;
  city_in_title: boolean;
  keyword_in_h1: boolean;
  city_in_h1: boolean;
  keyword_mentions: number;
  city_mentions: number;
  has_phone: boolean;
  signals: { signal: string; status: string; points: number }[];
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? "text-green-600 bg-green-500/10" :
    score >= 60 ? "text-yellow-600 bg-yellow-500/10" :
    "text-red-600 bg-red-500/10";
  return (
    <span className={`text-sm font-bold px-2 py-0.5 rounded ${color}`}>{score}/100</span>
  );
}

function SignalIcon({ status }: { status: string }) {
  if (status === "pass") return <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />;
  if (status === "partial") return <AlertCircle className="w-4 h-4 text-yellow-500 flex-shrink-0" />;
  return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
}

interface ClassifyResult {
  intent: "local" | "service_only";
  city: string;
  raw_service_terms: string[];
  match_words: string[];
  match_phrases: string[];
  haiku_expansions: Record<string, string[]>;  // unknown abbrev → up to 3 suggestions
}

function YourSiteTab({
  existingPages,
  businessWebsite,
  keyword,
  location,
}: {
  existingPages: ExistingPage[];
  businessWebsite: string;
  keyword: string;
  location: string;
}) {
  const [scores, setScores] = useState<Record<string, PageScore | "loading" | "error">>({});
  const [classify, setClassify] = useState<ClassifyResult | null>(null);
  // pendingExpansions: what the user is editing in the confirmation card
  const [pendingExpansions, setPendingExpansions] = useState<Record<string, string[]>>({});
  // customInputs: the "add term" text boxes, one per abbreviation
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  // expansionsConfirmed: user clicked "Confirm" (or no haiku expansions exist)
  const [expansionsConfirmed, setExpansionsConfirmed] = useState(false);

  // Fetch backend classification on mount
  useEffect(() => {
    if (!keyword || !location) return;
    setClassify(null);
    setExpansionsConfirmed(false);
    setPendingExpansions({});
    setCustomInputs({});
    fetch(`${NLP_SERVICE_URL}/classify-keyword`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
      body: JSON.stringify({ keyword, location }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data: ClassifyResult | null) => {
        if (!data) return;
        setClassify(data);
        const hx = data.haiku_expansions ?? {};
        setPendingExpansions(hx);
        // No abbreviations found → nothing to confirm, treat as already confirmed
        if (Object.keys(hx).length === 0) setExpansionsConfirmed(true);
      })
      .catch(() => { setExpansionsConfirmed(true); /* fallback path, skip confirmation */ });
  }, [keyword, location]);

  // Fallback (while classify is loading or call failed)
  const city = location.split(",")[0].trim().toLowerCase();
  const kwLower = keyword.toLowerCase();
  const NEAR_ME_SIGNALS_FB = ["near me", "nearby", "near by", "closest", "open now", "open 24"];
  const fallbackIsLocal = city.split(" ").some(
    (w) => w.length > 2 && new RegExp(`\\b${w}\\b`, "i").test(kwLower)
  ) || NEAR_ME_SIGNALS_FB.some((s) => kwLower.includes(s));
  const fallbackCityWords = new Set(city.split(" ").filter((w) => w.length > 2));
  const fallbackServiceTerms = kwLower.split(/\s+/).filter(
    (w) => w.length > 3 && !fallbackCityWords.has(w)
  );

  // Active classification — prefer backend result, fall back to local
  const isLocalKeyword = classify ? classify.intent === "local" : fallbackIsLocal;
  const activeCity = classify ? classify.city : city;
  const serviceTerms: string[] = classify ? classify.raw_service_terms : fallbackServiceTerms;

  // Build effective match terms: static expansion (always applied) + confirmed Haiku expansions
  const effectiveMatchWords: string[] = (() => {
    const base = classify ? [...classify.match_words] : [];
    if (expansionsConfirmed) {
      Object.values(pendingExpansions).flat().forEach((exp) => {
        if (!exp.includes(" ")) base.push(exp);
      });
    }
    return base;
  })();

  const effectiveMatchPhrases: string[] = (() => {
    const base = classify ? [...classify.match_phrases] : [];
    if (expansionsConfirmed) {
      Object.values(pendingExpansions).flat().forEach((exp) => {
        if (exp.includes(" ")) base.push(exp);
      });
    }
    return base;
  })();

  const matchesCity = (p: ExistingPage) => {
    const text = `${p.url} ${p.title ?? ""} ${p.h1 ?? ""} ${p.primary_city ?? ""}`.toLowerCase();
    return text.includes(activeCity);
  };

  const matchesService = (p: ExistingPage) => {
    const text = `${p.url} ${p.title ?? ""} ${p.h1 ?? ""}`.toLowerCase();
    if (classify && expansionsConfirmed) {
      if (effectiveMatchPhrases.some((ph) => text.includes(ph))) return true;
      if (effectiveMatchWords.some((w) => new RegExp(`\\b${w}\\b`).test(text))) return true;
      return effectiveMatchWords.length === 0 && effectiveMatchPhrases.length === 0;
    }
    if (classify && !expansionsConfirmed) {
      // Static matches only while waiting for confirmation
      if (classify.match_phrases.some((ph) => text.includes(ph))) return true;
      if (classify.match_words.some((w) => new RegExp(`\\b${w}\\b`).test(text))) return true;
      return classify.match_words.length === 0 && classify.match_phrases.length === 0;
    }
    if (fallbackServiceTerms.length === 0) return true;
    return fallbackServiceTerms.some((t) => text.includes(t));
  };

  const addCustomTerm = (abbrev: string) => {
    const val = (customInputs[abbrev] ?? "").trim().toLowerCase();
    if (!val) return;
    setPendingExpansions((prev) => ({
      ...prev,
      [abbrev]: [...(prev[abbrev] ?? []), val],
    }));
    setCustomInputs((prev) => ({ ...prev, [abbrev]: "" }));
  };

  // Classification differs by intent:
  // Local keyword  → query pages need both service + city match (city_service pages)
  // Service keyword → query pages need only service match (service pages, no geo required)
  const queryPages = isLocalKeyword
    ? existingPages.filter((p) => matchesCity(p) && matchesService(p))
    : existingPages.filter((p) => matchesService(p) && p.page_type === "service");

  const servicePages = isLocalKeyword
    ? existingPages.filter((p) => !matchesCity(p) && matchesService(p) && p.page_type === "service")
    : []; // not meaningful for service-only keywords

  const locationPages = isLocalKeyword
    ? existingPages.filter((p) => matchesCity(p) && !matchesService(p) && p.page_type === "location")
    : existingPages.filter((p) => matchesCity(p) && p.page_type === "location");

  const handleScore = async (url: string) => {
    setScores((s) => ({ ...s, [url]: "loading" }));
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/score-existing-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({ url, keyword, city: location.split(",")[0].trim() }),
      });
      if (!res.ok) throw new Error();
      const data: PageScore = await res.json();
      setScores((s) => ({ ...s, [url]: data }));
    } catch {
      setScores((s) => ({ ...s, [url]: "error" }));
    }
  };

  const PageList = ({ pages, label, emptyMsg }: { pages: ExistingPage[]; label: string; emptyMsg: string }) => (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{pages.length}</span>
      </div>
      {pages.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-2">{emptyMsg}</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
          {pages.map((p) => {
            const scoreState = scores[p.url];
            const scored = scoreState && scoreState !== "loading" && scoreState !== "error" ? scoreState as PageScore : null;
            return (
              <div key={p.url} className="px-4 py-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{p.title || p.url}</p>
                    <a href={isSafeUrl(p.url) ? p.url : "#"} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:text-foreground truncate block">
                      {p.url}
                    </a>
                    {p.h1 && <p className="text-xs text-muted-foreground mt-0.5 italic">H1: {p.h1}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {scored && <ScoreBadge score={scored.score} />}
                    {scoreState === "error" && <span className="text-xs text-red-500">Error</span>}
                    <button
                      onClick={() => handleScore(p.url)}
                      disabled={scoreState === "loading"}
                      className="text-xs text-primary hover:underline disabled:opacity-50 flex items-center gap-1"
                    >
                      {scoreState === "loading" && <Loader2 className="w-3 h-3 animate-spin" />}
                      {scored ? "Re-score" : "Score"}
                    </button>
                  </div>
                </div>
                {scored && (
                  <div className="bg-muted/40 rounded-md p-3 space-y-1.5">
                    <p className="text-xs font-medium text-foreground mb-2">
                      {scored.word_count.toLocaleString()} words · {scored.keyword_mentions} keyword mentions · {scored.city_mentions} city mentions
                    </p>
                    {scored.signals.map((sig, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <SignalIcon status={sig.status} />
                        <span className="text-xs text-foreground flex-1">{sig.signal}</span>
                        <span className="text-xs text-muted-foreground">{sig.points}pt</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  if (existingPages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No existing pages found for this business. Run a business analysis from the Locations page first.
      </p>
    );
  }

  // Whether we have unconfirmed Haiku suggestions to show
  const hasPendingConfirmation = classify && !expansionsConfirmed && Object.keys(pendingExpansions).length > 0;
  // All active match terms (for display once confirmed)
  const allActiveTerms = [...effectiveMatchPhrases, ...effectiveMatchWords];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Pages found on the business website, classified against your keyword and city.
          Click <strong>Score</strong> to scrape and evaluate any page.
        </p>
        {classify && expansionsConfirmed && allActiveTerms.length > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Matching on:{" "}
            <span className="text-foreground">{allActiveTerms.join(", ")}</span>
          </p>
        )}
        {!classify && (
          <p className="text-[10px] text-muted-foreground italic">Classifying keyword…</p>
        )}
      </div>

      {/* Haiku expansion confirmation card */}
      {hasPendingConfirmation && (
        <div className="bg-accent/5 border border-accent/20 rounded-xl p-4 space-y-4">
          <div className="flex items-start gap-2">
            <Sparkles className="w-4 h-4 text-accent mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">Confirm term expansions</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                We detected possible abbreviations in your keyword. Confirm what each means
                so we can find matching pages correctly. Remove any that are wrong, or add your own.
              </p>
            </div>
          </div>

          {Object.entries(pendingExpansions).map(([abbrev, expansions]) => (
            <div key={abbrev} className="space-y-2">
              <p className="text-xs font-medium text-foreground">
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{abbrev}</span>
                {" "}refers to:
              </p>
              <div className="flex flex-wrap gap-1.5 items-center">
                {expansions.length === 0 && (
                  <span className="text-xs text-muted-foreground italic">No expansions — add one below or confirm to skip.</span>
                )}
                {expansions.map((exp) => (
                  <span
                    key={exp}
                    className="inline-flex items-center gap-1 text-xs bg-muted text-foreground px-2.5 py-1 rounded-full"
                  >
                    {exp}
                    <button
                      onClick={() =>
                        setPendingExpansions((prev) => ({
                          ...prev,
                          [abbrev]: prev[abbrev].filter((e) => e !== exp),
                        }))
                      }
                      className="hover:text-destructive ml-0.5 flex-shrink-0"
                      aria-label={`Remove ${exp}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {/* Add custom term */}
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={customInputs[abbrev] ?? ""}
                    onChange={(e) =>
                      setCustomInputs((prev) => ({ ...prev, [abbrev]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addCustomTerm(abbrev);
                    }}
                    placeholder="Add term…"
                    className="text-xs bg-background border border-input rounded-full px-2.5 py-1 w-28 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={() => addCustomTerm(abbrev)}
                    className="text-xs text-primary hover:underline"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          ))}

          <button
            onClick={() => setExpansionsConfirmed(true)}
            className="text-sm font-semibold text-accent-foreground bg-accent hover:opacity-90 px-4 py-2 rounded-lg"
          >
            Confirm and search
          </button>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        {[
          {
            label: isLocalKeyword ? "Query pages" : "Service pages",
            count: queryPages.length,
            desc: keyword,
          },
          {
            label: "Supporting service pages",
            count: servicePages.length,
            desc: serviceTerms.join(" ") || keyword,
          },
          {
            label: "Location pages",
            count: locationPages.length,
            desc: location.split(",")[0],
          },
        ].map(({ label, count, desc }) => (
          <div key={label} className="bg-card border border-border rounded-xl p-3 text-center">
            <p className="text-2xl font-bold">{count}</p>
            <p className="text-xs font-medium text-foreground mt-0.5">{label}</p>
            <p className="text-[10px] text-muted-foreground truncate mt-0.5">{desc}</p>
          </div>
        ))}
      </div>
      <PageList
        pages={queryPages}
        label={
          isLocalKeyword
            ? `Local landing pages — "${keyword}"`
            : `Service pages targeting "${keyword}"`
        }
        emptyMsg={
          isLocalKeyword
            ? "No pages found targeting both service and city."
            : "No top-level service page found for this keyword."
        }
      />
      {isLocalKeyword && (
        <PageList
          pages={servicePages}
          label={`Supporting service pages — "${serviceTerms.join(" ") || keyword}" (no geo)`}
          emptyMsg="No top-level service page found. Consider adding one to build topical authority."
        />
      )}
      <PageList
        pages={locationPages}
        label={`Location pages — "${location.split(",")[0]}"`}
        emptyMsg={
          isLocalKeyword
            ? "No location page found for this city."
            : `No location page found for "${location.split(",")[0]}".`
        }
      />
    </div>
  );
}

const TABS = ["Related Keywords", "Key Phrases", "Topics Google Sees", "Sources", "Your Site"] as const;
type Tab = typeof TABS[number];

const AnalysisResultsView = ({
  result,
  businessName,
  existingPages = [],
  businessWebsite = "",
  onBack,
}: {
  result: AnalysisResult;
  businessName: string;
  existingPages?: ExistingPage[];
  businessWebsite?: string;
  onBack: () => void;
}) => {
  const [activeTab, setActiveTab] = useState<Tab>("Related Keywords");

  const totalRelated =
    result.related_keywords.title.length +
    result.related_keywords.h1.length +
    result.related_keywords.h2_h3.length +
    result.related_keywords.body.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <button
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors"
        >
          ← Back to Analysis
        </button>
        <h1 className="text-2xl font-display font-bold text-foreground">
          {result.keyword}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {result.location} &middot; {businessName} &middot; {result.serp_urls.length} pages analysed
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Related Keywords", value: totalRelated },
          { label: "Key Phrases", value: result.top_quadgrams.length },
          { label: "Topics", value: result.google_entities.length },
          { label: "Existing Pages", value: existingPages.length },
        ].map(({ label, value }) => (
          <div key={label} className="bg-card border border-border rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-foreground">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted rounded-lg p-1">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
              activeTab === tab
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "Related Keywords" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Words and phrases used by the top-ranking competitor pages. Include these naturally in your content.
          </p>
          {(["title", "h1", "h2_h3", "body"] as const).map((zone) => (
            <KeywordZoneTable
              key={zone}
              zone={zone}
              keywords={result.related_keywords[zone]}
            />
          ))}
          {totalRelated === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No related keywords found. Try a more specific keyword or different location.
            </p>
          )}
        </div>
      )}

      {activeTab === "Key Phrases" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Phrases that appear repeatedly across the top-ranking competitor pages. Weaving these into your content signals relevance to Google.
          </p>
          {result.top_quadgrams.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No common phrases found across competitor pages.
            </p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
              {result.top_quadgrams.map((q, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors">
                  <span className="text-sm text-foreground font-medium">"{q.phrase}"</span>
                  <SpreadBadge pct={q.page_spread_pct} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "Topics Google Sees" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Topics Google considers central to competitor pages. Mentioning these helps Google understand what your page is about.
          </p>
          {result.google_entities.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No key topics found across competitor pages.
            </p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
              {result.google_entities.map((e, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors">
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        ENTITY_TYPE_COLORS[e.entity_type] || ENTITY_TYPE_COLORS.OTHER
                      }`}
                    >
                      {ENTITY_FRIENDLY_LABELS[e.entity_type] || e.entity_type}
                    </span>
                    <span className="text-sm text-foreground font-medium">{e.name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <SpreadBadge pct={e.page_spread_pct} />
                    <span className="text-xs text-muted-foreground">
                      mention {e.recommended_mentions}×
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "Sources" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Competitor pages scraped and analysed for this keyword.
          </p>
          <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
            {result.serp_urls.filter(isSafeUrl).map((url, i) => (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors"
              >
                <span className="text-xs text-muted-foreground w-5 text-right flex-shrink-0">{i + 1}</span>
                <span className="text-sm text-foreground truncate flex-1">{url}</span>
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              </a>
            ))}
          </div>
        </div>
      )}

      {activeTab === "Your Site" && (
        <YourSiteTab
          existingPages={existingPages}
          businessWebsite={businessWebsite}
          keyword={result.keyword}
          location={result.location}
        />
      )}
    </div>
  );
};

export default AnalysisResultsView;
