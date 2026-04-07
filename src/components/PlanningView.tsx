import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Plus, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { nlp } from "@/lib/nlp-client";
import { LocationAutocomplete } from "@/components/LocationAutocomplete";
import type { RelatedPageItem } from "@/lib/nlp-types";

interface Business {
  id: string;
  business_name: string;
  website?: string;
  gbp_category?: string;
  address?: string;
}

interface RankabilityResult {
  verdict: string;
  match_count: number;
  total_results: number;
  ranking_categories: { category: string; count: number }[];
  message: string;
}

interface Props {
  onCreatePage: (keyword: string, location: string) => void;
  initialKeyword?: string;
  initialLocation?: string;
}

// Map API group names to display labels
const GROUP_LABELS: Record<string, string> = {
  parents:  "Parent",
  siblings: "Sibling",
  children: "Neighbourhood",
};
const GROUP_ORDER = ["parents", "siblings", "children"];

export default function PlanningView({ onCreatePage, initialKeyword = "", initialLocation = "" }: Props) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessesLoaded, setBusinessesLoaded] = useState(false);
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState(initialKeyword);
  const [location, setLocation] = useState(initialLocation);
  const [locationInput, setLocationInput] = useState(initialLocation);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<RelatedPageItem[]>([]);
  const [error, setError] = useState("");
  const [rankabilityMap, setRankabilityMap] = useState<Record<string, RankabilityResult>>({});
  const [rankabilityLoading, setRankabilityLoading] = useState<Record<string, boolean>>({});

  // Lazy-load businesses
  const loadBusinesses = async () => {
    if (businessesLoaded) return;
    const { data } = await supabase
      .from("business_profiles")
      .select("id, business_name, website, gbp_category, address")
      .order("business_name");
    setBusinesses(data ?? []);
    setBusinessesLoaded(true);
  };

  const selectedBusiness = businesses.find(b => b.id === selectedBusinessId);

  const handleScan = async () => {
    if (!selectedBusiness || !keyword.trim() || !location) return;
    setScanning(true);
    setResults([]);
    setError("");
    setRankabilityMap({});

    try {
      const { items } = await nlp.relatedPages({
        keyword: keyword.trim(),
        location,
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
    if (!selectedBusiness?.gbp_category || !location) return;
    setRankabilityLoading(prev => ({ ...prev, [kw]: true }));
    try {
      const data = await nlp.checkRankability({
        keyword: kw,
        location,
        gbp_category: selectedBusiness.gbp_category,
      });
      setRankabilityMap(prev => ({ ...prev, [kw]: data }));
    } catch {
      setRankabilityMap(prev => ({
        ...prev,
        [kw]: { verdict: "unknown", match_count: 0, total_results: 0, ranking_categories: [], message: "Could not retrieve map pack data." },
      }));
    } finally {
      setRankabilityLoading(prev => ({ ...prev, [kw]: false }));
    }
  };

  const grouped = GROUP_ORDER.map(grp => ({
    group: grp,
    label: GROUP_LABELS[grp],
    items: results.filter(r => r.group === grp),
  })).filter(g => g.items.length > 0);

  const missingCount = results.filter(r => r.status === "missing").length;
  const existsCount  = results.filter(r => r.status === "found").length;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Content Planning</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Discover missing local SEO pages for a keyword by checking what related pages your site already has.
        </p>
      </div>

      {/* Form */}
      <div className="bg-card border rounded-xl p-5 space-y-4">
        <div className="space-y-1.5">
          <Label>Business</Label>
          <Select
            value={selectedBusinessId}
            onValueChange={setSelectedBusinessId}
            onOpenChange={open => open && loadBusinesses()}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a business…" />
            </SelectTrigger>
            <SelectContent>
              {businesses.map(b => (
                <SelectItem key={b.id} value={b.id}>{b.business_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedBusiness?.website && (
            <p className="text-xs text-muted-foreground">{selectedBusiness.website}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Seed Keyword</Label>
            <Input
              placeholder="e.g. tree service"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              disabled={scanning}
            />
          </div>
          <LocationAutocomplete
            label="Location"
            value={location}
            inputValue={locationInput}
            onSelect={(loc) => { setLocation(loc.name); setLocationInput(loc.name); }}
            onInputChange={(raw) => { setLocationInput(raw); setLocation(""); }}
            onClear={() => { setLocation(""); setLocationInput(""); }}
            disabled={scanning}
          />
        </div>

        <Button
          className="w-full"
          onClick={handleScan}
          disabled={scanning || !selectedBusiness || !keyword.trim() || !location}
        >
          {scanning
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyzing…</>
            : <><Search className="w-4 h-4 mr-2" />Scan Site</>
          }
        </Button>
      </div>

      {/* Loading */}
      {scanning && (
        <div className="bg-muted/30 border rounded-xl p-6 flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin" />
          <p className="text-sm">Discovering related keywords and checking your site…</p>
          <p className="text-xs opacity-60">This takes about 30–60 seconds</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">{error}</p>
      )}

      {/* Results */}
      {!scanning && results.length > 0 && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium">{results.length} related keywords checked</span>
            <Badge className="bg-green-100 text-green-700 hover:bg-green-100">{existsCount} pages exist</Badge>
            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">{missingCount} missing</Badge>
          </div>

          {/* Grouped results */}
          {grouped.map(({ group, label, items }) => (
            <div key={group} className="bg-card border rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-muted/40 border-b">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label} Keywords</span>
              </div>
              <div className="divide-y">
                {items.map((item, i) => {
                  const rank = rankabilityMap[item.keyword];
                  const rankLoading = rankabilityLoading[item.keyword];
                  return (
                    <div key={i} className="px-4 py-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{item.keyword}</p>
                          {item.url && (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-muted-foreground hover:text-accent flex items-center gap-1 mt-0.5 truncate"
                            >
                              <ExternalLink className="w-3 h-3 shrink-0" />
                              <span className="truncate">{item.page_title || item.url}</span>
                            </a>
                          )}
                        </div>

                        {/* Composite score badge for existing pages */}
                        {item.composite_score != null && (
                          <span className={`text-xs font-semibold shrink-0 ${
                            item.composite_score >= 80 ? "text-green-500"
                            : item.composite_score >= 60 ? "text-amber-500"
                            : "text-red-500"
                          }`}>
                            {Math.round(item.composite_score)}/100
                          </span>
                        )}

                        <Badge
                          className={`shrink-0 ${item.status === "found"
                            ? "bg-green-100 text-green-700 hover:bg-green-100"
                            : "bg-amber-100 text-amber-700 hover:bg-amber-100"}`}
                        >
                          {item.status === "found" ? "Exists" : "Missing"}
                        </Badge>

                        {item.status === "missing" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => onCreatePage(item.keyword, location)}
                          >
                            <Plus className="w-3.5 h-3.5 mr-1" />
                            Create
                          </Button>
                        )}
                        {item.status === "found" && item.url && (
                          <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" asChild>
                            <a href={item.url} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </Button>
                        )}
                      </div>

                      {rank && (
                        <div className={`text-xs px-2.5 py-1.5 rounded-md border ${
                          rank.verdict === "match"   ? "bg-green-50 border-green-200 text-green-700" :
                          rank.verdict === "partial" ? "bg-amber-50 border-amber-200 text-amber-700" :
                                                       "bg-red-50 border-red-200 text-red-700"
                        }`}>
                          <span className="font-medium">{
                            rank.verdict === "match"    ? "✓ Strong Maps rankability" :
                            rank.verdict === "partial"  ? "⚠ Partial category match" :
                            rank.verdict === "mismatch" ? "✗ Category mismatch" : "Unknown"
                          }</span>
                          {rank.total_results > 0 && (
                            <span className="ml-1.5 opacity-80">({rank.match_count}/{rank.total_results} map results match your category)</span>
                          )}
                          {rank.verdict === "partial" && (
                            <p className="mt-0.5 opacity-90">You may be able to rank with a highly optimized page, but will need strong off-page signals.</p>
                          )}
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
