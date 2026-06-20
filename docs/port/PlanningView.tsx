/**
 * PlanningView — portable "Content Planning" UI.
 *
 * Ported from ShowUP Local's PlanningView.tsx and decoupled from Supabase / the
 * NLP client / shadcn form widgets. Lets the user pick a business + seed keyword +
 * location, scans the site for related pages, and shows a grouped exists/missing
 * gap report with Create / external-link actions (and an optional rankability check).
 *
 * Deps: react, lucide-react, Tailwind CSS (shadcn-style tokens — remap if needed).
 * Plain <input>/<select> are used so there's no UI-library dependency.
 * See CONTENT_PLANNING_PRD.md for the full spec.
 */
import { useState } from "react";
import { Loader2, Search, Plus, ExternalLink } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────
export interface PlanningBusiness {
  id: string;
  business_name: string;
  website?: string;
  gbp_category?: string;
  address?: string;
}

export interface RelatedPageItem {
  keyword: string;
  group: string;        // "parents" | "siblings" | "children"
  status: string;       // "found" | "missing"
  url?: string | null;
  page_title?: string | null;
  composite_score?: number | null;
}

export interface RankabilityResult {
  verdict: string;      // "match" | "partial" | "mismatch" | "unknown"
  match_count: number;
  total_results: number;
  message?: string;
}

export interface PlanningApi {
  /** POST /related-pages equivalent. */
  relatedPages(input: {
    keyword: string; location: string; business_name: string;
    gbp_category: string; address?: string; website?: string;
  }): Promise<{ items: RelatedPageItem[] }>;
  /** OPTIONAL — per-keyword Maps rankability check. Omit to hide the action. */
  checkRankability?(input: { keyword: string; location: string; gbp_category: string }): Promise<RankabilityResult>;
}

export interface PlanningViewProps {
  /** Businesses to choose from (load these however your app does). */
  businesses: PlanningBusiness[];
  api: PlanningApi;
  onCreatePage: (keyword: string, location: string) => void;
  initialKeyword?: string;
  initialLocation?: string;
}

const GROUP_LABELS: Record<string, string> = { parents: "Parent", siblings: "Sibling", children: "Neighbourhood" };
const GROUP_ORDER = ["parents", "siblings", "children"];

// ── Component ────────────────────────────────────────────────────────────────────
export default function PlanningView({ businesses, api, onCreatePage, initialKeyword = "", initialLocation = "" }: PlanningViewProps) {
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState(initialKeyword);
  const [location, setLocation] = useState(initialLocation);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<RelatedPageItem[]>([]);
  const [error, setError] = useState("");
  const [rankabilityMap, setRankabilityMap] = useState<Record<string, RankabilityResult>>({});
  const [rankabilityLoading, setRankabilityLoading] = useState<Record<string, boolean>>({});

  const selectedBusiness = businesses.find((b) => b.id === selectedBusinessId);

  const handleScan = async () => {
    if (!selectedBusiness || !keyword.trim() || !location.trim()) return;
    setScanning(true);
    setResults([]);
    setError("");
    setRankabilityMap({});
    try {
      const { items } = await api.relatedPages({
        keyword: keyword.trim(),
        location: location.trim(),
        business_name: selectedBusiness.business_name,
        gbp_category: selectedBusiness.gbp_category ?? "",
        address: selectedBusiness.address,
        website: selectedBusiness.website,
      });
      setResults(items);
    } catch (e: any) {
      setError(e.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const handleCheckRankability = async (kw: string) => {
    if (!api.checkRankability || !selectedBusiness?.gbp_category || !location.trim()) return;
    setRankabilityLoading((prev) => ({ ...prev, [kw]: true }));
    try {
      const data = await api.checkRankability({ keyword: kw, location: location.trim(), gbp_category: selectedBusiness.gbp_category });
      setRankabilityMap((prev) => ({ ...prev, [kw]: data }));
    } catch {
      setRankabilityMap((prev) => ({ ...prev, [kw]: { verdict: "unknown", match_count: 0, total_results: 0, message: "Could not retrieve map pack data." } }));
    } finally {
      setRankabilityLoading((prev) => ({ ...prev, [kw]: false }));
    }
  };

  const grouped = GROUP_ORDER.map((grp) => ({ group: grp, label: GROUP_LABELS[grp], items: results.filter((r) => r.group === grp) })).filter((g) => g.items.length > 0);
  const missingCount = results.filter((r) => r.status === "missing").length;
  const existsCount = results.filter((r) => r.status === "found").length;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Content Planning</h1>
        <p className="text-muted-foreground text-sm mt-1">Discover missing local SEO pages for a keyword by checking what related pages your site already has.</p>
      </div>

      {/* Form */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Business</label>
          <select
            value={selectedBusinessId}
            onChange={(e) => setSelectedBusinessId(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Select a business…</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.business_name}</option>)}
          </select>
          {selectedBusiness?.website && <p className="text-xs text-muted-foreground">{selectedBusiness.website}</p>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Seed Keyword</label>
            <input
              placeholder="e.g. tree service"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              disabled={scanning}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Location</label>
            <input
              placeholder="e.g. Anaheim, California, United States"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              disabled={scanning}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </div>
        </div>

        <button
          className="w-full inline-flex items-center justify-center rounded-md bg-accent text-accent-foreground hover:opacity-90 font-medium py-2.5 disabled:opacity-50"
          onClick={handleScan}
          disabled={scanning || !selectedBusiness || !keyword.trim() || !location.trim()}
        >
          {scanning ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyzing…</> : <><Search className="w-4 h-4 mr-2" />Scan Site</>}
        </button>
      </div>

      {/* Loading */}
      {scanning && (
        <div className="bg-muted/30 border border-border rounded-xl p-6 flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin" />
          <p className="text-sm">Discovering related keywords and checking your site…</p>
          <p className="text-xs opacity-60">This takes about 30–60 seconds</p>
        </div>
      )}

      {/* Error */}
      {error && <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">{error}</p>}

      {/* Results */}
      {!scanning && results.length > 0 && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium">{results.length} related keywords checked</span>
            <span className="rounded-full bg-green-100 text-green-700 px-2.5 py-0.5 text-xs font-medium">{existsCount} pages exist</span>
            <span className="rounded-full bg-amber-100 text-amber-700 px-2.5 py-0.5 text-xs font-medium">{missingCount} missing</span>
          </div>

          {/* Grouped results */}
          {grouped.map(({ group, label, items }) => (
            <div key={group} className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-muted/40 border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label} Keywords</span>
              </div>
              <div className="divide-y divide-border">
                {items.map((item, i) => {
                  const rank = rankabilityMap[item.keyword];
                  const rankLoading = rankabilityLoading[item.keyword];
                  return (
                    <div key={i} className="px-4 py-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{item.keyword}</p>
                          {item.url && (
                            <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-accent flex items-center gap-1 mt-0.5 truncate">
                              <ExternalLink className="w-3 h-3 shrink-0" />
                              <span className="truncate">{item.page_title || item.url}</span>
                            </a>
                          )}
                        </div>

                        {item.composite_score != null && (
                          <span className={`text-xs font-semibold shrink-0 ${item.composite_score >= 80 ? "text-green-500" : item.composite_score >= 60 ? "text-amber-500" : "text-red-500"}`}>
                            {Math.round(item.composite_score)}/100
                          </span>
                        )}

                        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${item.status === "found" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                          {item.status === "found" ? "Exists" : "Missing"}
                        </span>

                        {api.checkRankability && (
                          <button onClick={() => handleCheckRankability(item.keyword)} disabled={rankLoading} className="shrink-0 text-xs text-muted-foreground hover:text-accent disabled:opacity-50">
                            {rankLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Rankability"}
                          </button>
                        )}

                        {item.status === "missing" && (
                          <button onClick={() => onCreatePage(item.keyword, location)} className="shrink-0 inline-flex items-center rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted">
                            <Plus className="w-3.5 h-3.5 mr-1" />Create
                          </button>
                        )}
                        {item.status === "found" && item.url && (
                          <a href={item.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-accent"><ExternalLink className="w-3.5 h-3.5" /></a>
                        )}
                      </div>

                      {rank && (
                        <div className={`text-xs px-2.5 py-1.5 rounded-md border ${
                          rank.verdict === "match" ? "bg-green-50 border-green-200 text-green-700" :
                          rank.verdict === "partial" ? "bg-amber-50 border-amber-200 text-amber-700" :
                          "bg-red-50 border-red-200 text-red-700"}`}>
                          <span className="font-medium">{
                            rank.verdict === "match" ? "✓ Strong Maps rankability" :
                            rank.verdict === "partial" ? "⚠ Partial category match" :
                            rank.verdict === "mismatch" ? "✗ Category mismatch" : "Unknown"
                          }</span>
                          {rank.total_results > 0 && <span className="ml-1.5 opacity-80">({rank.match_count}/{rank.total_results} map results match your category)</span>}
                          {rank.verdict === "partial" && <p className="mt-0.5 opacity-90">You may be able to rank with a highly optimized page, but will need strong off-page signals.</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
