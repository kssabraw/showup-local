import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

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
                <span className="text-xs text-muted-foreground w-12 text-right">
                  {(kw.score * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TABS = ["Related Keywords", "Quadgrams", "Entities", "Sources"] as const;
type Tab = typeof TABS[number];

const AnalysisResultsView = ({
  result,
  businessName,
  onBack,
}: {
  result: AnalysisResult;
  businessName: string;
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
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Related Keywords", value: totalRelated },
          { label: "Quadgrams", value: result.top_quadgrams.length },
          { label: "Key Entities", value: result.google_entities.length },
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
            Terms competitors use in each HTML zone, filtered to those appearing on ≥49% of competitor pages.
            Score = topical closeness to your keyword.
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

      {activeTab === "Quadgrams" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            4-word phrases from competitor paragraph text, filtered to those appearing on ≥49% of pages
            and semantically related to your keyword.
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
                  <div className="flex items-center gap-3">
                    <SpreadBadge pct={q.page_spread_pct} />
                    <span className="text-xs text-muted-foreground w-16 text-right">
                      sim {(q.similarity_score * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "Entities" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Entities Google's NLP API considers highly central (salience ≥ 0.40) to competitor pages.
            Recommended mentions = average times competitors reference this entity.
          </p>
          {result.google_entities.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No high-salience entities found. Check that GOOGLE_NLP_API_KEY is set in Railway.
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
                      {e.entity_type}
                    </span>
                    <span className="text-sm text-foreground font-medium">{e.name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <SpreadBadge pct={e.page_spread_pct} />
                    <span className="text-xs text-muted-foreground">
                      mention {e.recommended_mentions}×
                    </span>
                    <span className="text-xs text-muted-foreground w-16 text-right">
                      sal {(e.mean_salience * 100).toFixed(1)}%
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
            {result.serp_urls.map((url, i) => (
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
    </div>
  );
};

export default AnalysisResultsView;
