import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Plus, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "";
const NLP_API_KEY = import.meta.env.VITE_NLP_API_KEY ?? "";

interface Business {
  id: string;
  business_name: string;
  website?: string;
}

interface PlanItem {
  keyword: string;
  group: "primary" | "parent" | "sibling" | "child";
  status: "exists" | "missing";
  page_url?: string;
  page_title?: string;
}

interface Props {
  onCreatePage: (keyword: string, location: string) => void;
}

const GROUP_LABELS: Record<string, string> = {
  primary: "Primary",
  parent: "Parent",
  sibling: "Sibling",
  child: "Neighbourhood",
};

const GROUP_ORDER = ["primary", "parent", "sibling", "child"];

export default function PlanningView({ onCreatePage }: Props) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessesLoaded, setBusinessesLoaded] = useState(false);
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [location, setLocation] = useState("");
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [currentKw, setCurrentKw] = useState("");
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const [results, setResults] = useState<PlanItem[]>([]);
  const [error, setError] = useState("");
  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);

  // Lazy-load businesses
  const loadBusinesses = async () => {
    if (businessesLoaded) return;
    const { data } = await supabase
      .from("business_profiles")
      .select("id, business_name, website")
      .order("business_name");
    setBusinesses(data ?? []);
    setBusinessesLoaded(true);
  };

  const selectedBusiness = businesses.find(b => b.id === selectedBusinessId);

  const handleScan = async () => {
    if (!selectedBusiness?.website || !keyword.trim() || !location.trim()) return;
    setScanning(true);
    setProgress(0);
    setProgressMsg("Starting…");
    setResults([]);
    setError("");
    setCurrentKw("");
    setTotal(0);
    setCurrent(0);

    try {
      const res = await fetch(`${NLP_SERVICE_URL}/plan-pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": NLP_API_KEY },
        body: JSON.stringify({
          website_url: selectedBusiness.website,
          keyword: keyword.trim(),
          location: location.trim(),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);

      const reader = res.body.getReader();
      readerRef.current = reader;
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
          if (evt.progress !== undefined) setProgress(evt.progress);
          if (evt.message) setProgressMsg(evt.message);
          if (evt.total) setTotal(evt.total);
          if (evt.current) setCurrent(evt.current);
          if (evt.step === "checking_keyword") setCurrentKw(evt.message ?? "");
          if (evt.step === "keyword_result" && evt.item) {
            setResults(prev => [...prev, evt.item]);
          }
          if (evt.step === "error") throw new Error(evt.message || "Scan failed");
          if (evt.step === "done") break;
        }
      }
    } catch (e: any) {
      setError(e.message || "Scan failed");
    } finally {
      setScanning(false);
      setCurrentKw("");
    }
  };

  // Group results
  const grouped = GROUP_ORDER.map(grp => ({
    group: grp,
    label: GROUP_LABELS[grp],
    items: results.filter(r => r.group === grp),
  })).filter(g => g.items.length > 0);

  const missingCount = results.filter(r => r.status === "missing").length;
  const existsCount = results.filter(r => r.status === "exists").length;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Content Planning</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Scan your site to discover missing local SEO pages for a keyword + location.
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
          <div className="space-y-1.5">
            <Label>Location <span className="text-destructive">*</span></Label>
            <Input
              placeholder="e.g. Newport Beach, CA"
              value={location}
              onChange={e => setLocation(e.target.value)}
              disabled={scanning}
            />
          </div>
        </div>

        <Button
          className="w-full"
          onClick={handleScan}
          disabled={scanning || !selectedBusiness?.website || !keyword.trim() || !location.trim()}
        >
          {scanning
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Scanning…</>
            : <><Search className="w-4 h-4 mr-2" />Scan Site</>
          }
        </Button>
      </div>

      {/* Progress */}
      {scanning && (
        <div className="bg-muted/30 border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">{progressMsg}</span>
            {total > 0 && <span>{current}/{total} keywords</span>}
          </div>
          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          {currentKw && (
            <p className="text-xs text-muted-foreground truncate">{currentKw}</p>
          )}
          {/* Stream in results as they arrive */}
          {results.length > 0 && (
            <div className="space-y-1 pt-1">
              {results.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-0.5">
                  <span className="text-foreground truncate flex-1">{item.keyword}</span>
                  <Badge
                    variant={item.status === "exists" ? "default" : "secondary"}
                    className={`ml-2 shrink-0 text-[10px] ${item.status === "exists" ? "bg-green-100 text-green-700 hover:bg-green-100" : "bg-amber-100 text-amber-700 hover:bg-amber-100"}`}
                  >
                    {item.status === "exists" ? "Exists" : "Missing"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
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
            <span className="font-medium">{results.length} keywords checked</span>
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
                {items.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.keyword}</p>
                      {item.page_url && (
                        <a
                          href={item.page_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-accent flex items-center gap-1 mt-0.5 truncate"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          <span className="truncate">{item.page_title || item.page_url}</span>
                        </a>
                      )}
                    </div>
                    <Badge
                      className={`shrink-0 ${item.status === "exists" ? "bg-green-100 text-green-700 hover:bg-green-100" : "bg-amber-100 text-amber-700 hover:bg-amber-100"}`}
                    >
                      {item.status === "exists" ? "Exists" : "Missing"}
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
                    {item.status === "exists" && item.page_url && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground"
                        asChild
                      >
                        <a href={item.page_url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
