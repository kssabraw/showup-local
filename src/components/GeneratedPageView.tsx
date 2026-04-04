import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check, Save, Loader2, ExternalLink, Download, Mail, ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "";
const API_KEY = import.meta.env.VITE_NLP_API_KEY ?? "";

interface Props {
  keyword: string;
  location: string;
  mode: "generate" | "reoptimize";
  contentHtml: string;
  schemaJson: string;
  pageTitle: string;
  htmlCssNotes?: string[];
  tokenUsage: Record<string, any>;
  costBreakdown?: Record<string, any>;
  businessId: string;
  businessName: string;
  website?: string;
  gbpCategory: string;
  address: string;
  onBack: () => void;
  onNewPage: () => void;
  onRelatedAction?: (action: { mode: "reoptimize" | "new"; keyword: string; existingUrl?: string }) => void;
}

interface RelatedPageItem {
  keyword: string;
  group: "parents" | "siblings" | "children";
  status: "found" | "missing";
  url?: string;
  page_title?: string;
  composite_score?: number;
  composite_status?: string;
  engine_scores?: Record<string, any>;
  deficiencies?: Array<{ engine: string; issue: string; fix: string }>;
}

type RelatedSelection = Record<string, "reoptimize" | "new" | null>;

function scoreColor(status?: string) {
  if (!status) return "text-muted-foreground";
  if (status === "strong") return "text-green-600";
  if (status === "good") return "text-blue-500";
  if (status === "needs_work") return "text-yellow-600";
  return "text-red-500";
}

function scoreBadge(score?: number, status?: string) {
  if (score == null) return null;
  return (
    <span className={`text-xs font-semibold ${scoreColor(status)}`}>
      {score.toFixed(0)}/100
    </span>
  );
}

export default function GeneratedPageView({
  keyword, location, mode, contentHtml, schemaJson, pageTitle, htmlCssNotes,
  tokenUsage, costBreakdown,
  businessId, businessName, website, gbpCategory, address,
  onBack, onNewPage, onRelatedAction,
}: Props) {
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [copiedRichText, setCopiedRichText] = useState(false);
  const [showCostBreakdown, setShowCostBreakdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [activeTab, setActiveTab] = useState<"preview" | "raw-text" | "html" | "schema" | "related">("preview");
  const [showCmsInstructions, setShowCmsInstructions] = useState(false);
  const [activeCms, setActiveCms] = useState<"wordpress" | "wix" | "squarespace" | "webflow">("wordpress");
  // Related pages state
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedItems, setRelatedItems] = useState<RelatedPageItem[] | null>(null);
  const [relatedError, setRelatedError] = useState("");
  const [selections, setSelections] = useState<RelatedSelection>({});

  const copyHtml = async () => {
    await navigator.clipboard.writeText(contentHtml);
    setCopiedHtml(true);
    setTimeout(() => setCopiedHtml(false), 2000);
  };

  const copyRichText = async () => {
    try {
      // Copy as rich text (text/html) so it pastes with formatting into WordPress, Google Docs, etc.
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([contentHtml], { type: "text/html" }),
          "text/plain": new Blob(
            [new DOMParser().parseFromString(contentHtml, "text/html").body.innerText],
            { type: "text/plain" }
          ),
        }),
      ]);
    } catch {
      // Fallback: plain text
      await navigator.clipboard.writeText(
        new DOMParser().parseFromString(contentHtml, "text/html").body.innerText
      );
    }
    setCopiedRichText(true);
    setTimeout(() => setCopiedRichText(false), 2000);
  };

  const copySchema = async () => {
    await navigator.clipboard.writeText(schemaJson);
    setCopiedSchema(true);
    setTimeout(() => setCopiedSchema(false), 2000);
  };

  const downloadHtml = () => {
    const schemaTag = schemaJson
      ? `\n  <script type="application/ld+json">${schemaJson}<\/script>`
      : "";
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>${schemaTag}
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; color: #1a1a1a; line-height: 1.7; }
    h1 { font-size: 2rem; font-weight: 700; line-height: 1.2; margin-bottom: 1rem; }
    h2 { font-size: 1.5rem; font-weight: 600; margin-top: 2.5rem; margin-bottom: 0.75rem; }
    h3 { font-size: 1.2rem; font-weight: 600; margin-top: 1.75rem; margin-bottom: 0.5rem; }
    p { margin: 0.875rem 0; }
    ul, ol { margin: 0.875rem 0; padding-left: 1.5rem; }
    li { margin: 0.4rem 0; }
    strong { font-weight: 600; }
    a { color: #2563eb; }
    @media (max-width: 640px) { body { padding: 1rem; } h1 { font-size: 1.6rem; } }
  </style>
</head>
<body>
${contentHtml}
</body>
</html>`;
    const blob = new Blob([fullHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${keyword.replace(/\s+/g, "-").toLowerCase()}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const sendToDeveloper = () => {
    const slug = keyword.replace(/\s+/g, "-").toLowerCase();
    const city = location.split(",")[0].trim();
    const subject = encodeURIComponent(`New SEO page to add to the website — ${keyword} in ${city}`);
    const body = encodeURIComponent(
`Hi,

I used a tool called ShowUP Local to create a new SEO-optimised page for our website.

Please add this as a new page. A good URL would be something like:
/services/${slug}

Page title: ${pageTitle}
Target keyword: ${keyword}
Location: ${location}

I'm attaching the HTML file — please upload it or paste the content into a new page in our CMS.
${schemaJson ? "\nThe HTML file also includes JSON-LD schema markup in the <head> which helps Google understand the page. Please make sure that's included too.\n" : ""}
Let me know if you have any questions!`
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  const savePage = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const { error } = await supabase.from("generated_pages").insert({
        business_id: businessId,
        keyword,
        location,
        mode,
        page_title: pageTitle || null,
        content_html: contentHtml,
        schema_json: schemaJson || null,
      });
      if (error) throw error;
      setSaved(true);
    } catch (e: any) {
      setSaveError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const fetchRelatedPages = async () => {
    setRelatedLoading(true);
    setRelatedError("");
    setRelatedItems(null);
    try {
      const resp = await fetch(`${NLP_SERVICE_URL}/related-pages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
        },
        body: JSON.stringify({
          keyword,
          location,
          business_name: businessName,
          gbp_category: gbpCategory,
          address,
          website: website || null,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || "Request failed");
      }
      const data = await resp.json();
      setRelatedItems(data.items ?? []);
    } catch (e: any) {
      setRelatedError(e.message || "Failed to load related pages");
    } finally {
      setRelatedLoading(false);
    }
  };

  // Start fetching related pages in the background as soon as the component mounts
  useEffect(() => {
    fetchRelatedPages();
  }, []);

  // Also re-fetch if user manually retries from the related tab
  // (fetchRelatedPages is called directly from the Retry button)

  const toggleSelection = (kw: string, value: "reoptimize" | "new") => {
    setSelections(prev => ({
      ...prev,
      [kw]: prev[kw] === value ? null : value,
    }));
  };

  const handleGenerateSelected = () => {
    if (!onRelatedAction || !relatedItems) return;
    for (const item of relatedItems) {
      const sel = selections[item.keyword];
      if (!sel) continue;
      onRelatedAction({
        mode: sel,
        keyword: item.keyword,
        existingUrl: item.status === "found" ? item.url : undefined,
      });
      break; // launch one at a time — user will cycle through
    }
  };

  const wordCount = contentHtml
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;

  const selectedCount = Object.values(selections).filter(Boolean).length;

  const groupLabel = { parents: "Parent Pages", siblings: "Sibling Pages", children: "Child Pages" };
  const groups: Array<"parents" | "siblings" | "children"> = ["parents", "siblings", "children"];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
          ← Back
        </button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">
              {mode === "reoptimize" ? "Reoptimized Page" : "Generated Page"}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              <span className="font-medium">{keyword}</span> · {location.split(",")[0]} · ~{wordCount} words
            </p>
          </div>
          <div className="text-right">
            {costBreakdown?.total != null ? (
              <div className="text-sm font-semibold text-foreground">
                ${costBreakdown.total.toFixed(4)}
                <span className="text-xs font-normal text-muted-foreground ml-1">total est.</span>
              </div>
            ) : tokenUsage?.cost_usd != null ? (
              <div className="text-sm font-semibold text-foreground">
                ${tokenUsage.cost_usd.toFixed(5)}
              </div>
            ) : null}
            {(costBreakdown?.total != null || tokenUsage?.cost_usd != null) && (
              <button
                onClick={() => setShowCostBreakdown(v => !v)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors underline"
              >
                {showCostBreakdown ? "hide breakdown" : "see breakdown"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Cost breakdown panel */}
      {showCostBreakdown && (
        <div className="bg-muted/40 border border-border rounded-xl px-5 py-4 text-xs space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Cost Breakdown (estimates)</p>
          {[
            { label: "DataForSEO SERP fetch", value: costBreakdown?.dataforseo },
            { label: `ScrapeOwl (${costBreakdown?.scrapeowl_pages ?? 0} pages)`, value: costBreakdown?.scrapeowl },
            { label: `Google NLP (${((costBreakdown?.google_nlp_chars ?? 0) / 1000).toFixed(0)}k chars)`, value: costBreakdown?.google_nlp },
            { label: `Claude ${costBreakdown?.claude_model?.includes("haiku") ? "Haiku" : "Sonnet"} (${costBreakdown?.claude_input_tokens ?? 0}+${costBreakdown?.claude_output_tokens ?? 0} tokens)`, value: costBreakdown?.claude },
          ].map(({ label, value }) =>
            value != null ? (
              <div key={label} className="flex justify-between text-muted-foreground">
                <span>{label}</span>
                <span className="font-mono">${(value as number).toFixed(4)}</span>
              </div>
            ) : null
          )}
          <div className="flex justify-between font-semibold text-foreground border-t border-border pt-1.5 mt-1.5">
            <span>Total</span>
            <span className="font-mono">${(costBreakdown?.total ?? tokenUsage?.cost_usd ?? 0).toFixed(4)}</span>
          </div>
          <p className="text-muted-foreground/60 pt-1">* API costs are estimates based on published pricing. Actual billing may vary.</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border flex-wrap">
        {(["preview", "raw-text", "html", "schema", "related"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "schema" ? "JSON-LD Schema"
              : tab === "related" ? "Related Pages"
              : tab === "raw-text" ? "Raw Text"
              : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Preview tab */}
      {activeTab === "preview" && (
        <div className="space-y-3">
          {pageTitle && (
            <div className="flex items-start gap-3 px-4 py-3 bg-muted/40 rounded-lg border border-border">
              <span className="text-xs font-mono text-muted-foreground shrink-0 mt-0.5">&lt;title&gt;</span>
              <span className="text-sm text-foreground">{pageTitle}</span>
            </div>
          )}
          <div className="rounded-xl border border-border overflow-hidden bg-white">
            <iframe
              srcDoc={`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto;padding:2rem 1.5rem;color:#1a1a1a;line-height:1.75}h1{font-size:1.875rem;font-weight:700;line-height:1.2;margin-bottom:1rem}h2{font-size:1.375rem;font-weight:600;margin-top:2.5rem;margin-bottom:0.75rem}h3{font-size:1.15rem;font-weight:600;margin-top:1.75rem;margin-bottom:0.5rem}p{margin:0.875rem 0}ul,ol{margin:0.875rem 0;padding-left:1.5rem}li{margin:0.4rem 0}strong{font-weight:600}a{color:#2563eb}</style></head><body>${contentHtml}</body></html>`}
              style={{ width: "100%", height: "680px", border: "none", display: "block" }}
              sandbox="allow-same-origin"
              title="Page preview"
            />
          </div>
          {/* HTML/CSS improvement notes — reoptimize only */}
          {mode === "reoptimize" && htmlCssNotes && htmlCssNotes.length > 0 && (
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-5 space-y-3">
              <div>
                <p className="text-sm font-semibold text-foreground">Structural Improvements Recommended</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  These changes require editing your page's HTML/CSS and could not be applied automatically.
                </p>
              </div>
              <ul className="space-y-2">
                {htmlCssNotes.map((note, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                    <span className="text-amber-500 shrink-0 mt-0.5">→</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Raw Text tab */}
      {activeTab === "raw-text" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Select all and copy, then paste directly into WordPress, Google Docs, or any editor — formatting is preserved.
            </p>
            <Button variant="outline" size="sm" onClick={copyRichText}>
              {copiedRichText ? <><Check className="w-4 h-4 mr-1" /> Copied!</> : <><Copy className="w-4 h-4 mr-1" /> Copy All</>}
            </Button>
          </div>
          <div
            className="bg-white rounded-xl border border-border p-8 prose prose-sm max-w-none
                       prose-headings:text-gray-900 prose-p:text-gray-800 prose-li:text-gray-800
                       prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
                       prose-headings:font-bold prose-strong:font-bold
                       select-all cursor-text"
            dangerouslySetInnerHTML={{
              __html: contentHtml
                .replace(/\s*style="[^"]*"/gi, '')
                .replace(/\s*class="[^"]*"/gi, '')
            }}
          />
        </div>
      )}

      {/* HTML tab */}
      {activeTab === "html" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={copyHtml}>
              {copiedHtml ? <><Check className="w-4 h-4 mr-1" /> Copied</> : <><Copy className="w-4 h-4 mr-1" /> Copy HTML</>}
            </Button>
          </div>
          <pre className="bg-muted rounded-xl border border-border p-4 text-xs overflow-x-auto whitespace-pre-wrap font-mono text-foreground max-h-[600px] overflow-y-auto">
            {contentHtml}
          </pre>
        </div>
      )}

      {/* Schema tab */}
      {activeTab === "schema" && (
        <div className="space-y-3">
          {schemaJson ? (
            <>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={copySchema}>
                  {copiedSchema ? <><Check className="w-4 h-4 mr-1" /> Copied</> : <><Copy className="w-4 h-4 mr-1" /> Copy Schema</>}
                </Button>
              </div>
              <pre className="bg-muted rounded-xl border border-border p-4 text-xs overflow-x-auto whitespace-pre-wrap font-mono text-foreground max-h-[600px] overflow-y-auto">
                {schemaJson}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No schema was generated for this page.</p>
          )}
        </div>
      )}

      {/* Related Pages tab */}
      {activeTab === "related" && (
        <div className="space-y-4">
          {relatedLoading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="text-sm">Analyzing site architecture and checking for existing pages…</p>
            </div>
          )}

          {relatedError && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">
              {relatedError}
              <button onClick={fetchRelatedPages} className="ml-3 underline text-xs">Retry</button>
            </div>
          )}

          {relatedItems && relatedItems.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No related pages found.</p>
          )}

          {relatedItems && relatedItems.length > 0 && (
            <>
              {groups.map(group => {
                const groupItems = relatedItems.filter(i => i.group === group);
                if (groupItems.length === 0) return null;
                return (
                  <div key={group} className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{groupLabel[group]}</h3>
                    <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
                      {groupItems.map(item => {
                        const sel = selections[item.keyword];
                        return (
                          <div key={item.keyword} className="px-4 py-3 bg-card">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium text-foreground">{item.keyword}</span>
                                  {item.status === "found" ? (
                                    <span className="text-xs bg-green-100 text-green-700 rounded px-1.5 py-0.5">Found</span>
                                  ) : (
                                    <span className="text-xs bg-muted text-muted-foreground rounded px-1.5 py-0.5">Missing</span>
                                  )}
                                  {item.composite_score != null && scoreBadge(item.composite_score, item.composite_status)}
                                </div>
                                {item.status === "found" && item.url && (
                                  <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mt-0.5 truncate"
                                  >
                                    <ExternalLink className="w-3 h-3 shrink-0" />
                                    <span className="truncate">{item.page_title || item.url}</span>
                                  </a>
                                )}
                              </div>

                              {/* Action checkboxes */}
                              <div className="flex items-center gap-3 shrink-0">
                                {item.status === "found" && (
                                  <label className="flex items-center gap-1.5 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      className="rounded"
                                      checked={sel === "reoptimize"}
                                      onChange={() => toggleSelection(item.keyword, "reoptimize")}
                                    />
                                    <span className="text-xs text-muted-foreground">Reoptimize</span>
                                  </label>
                                )}
                                {item.status === "missing" && (
                                  <label className="flex items-center gap-1.5 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      className="rounded"
                                      checked={sel === "new"}
                                      onChange={() => toggleSelection(item.keyword, "new")}
                                    />
                                    <span className="text-xs text-muted-foreground">Create new</span>
                                  </label>
                                )}
                              </div>
                            </div>

                            {/* Deficiencies for found pages */}
                            {item.deficiencies && item.deficiencies.length > 0 && (
                              <ul className="mt-2 space-y-0.5">
                                {item.deficiencies.slice(0, 3).map((d, i) => (
                                  <li key={i} className="text-xs text-muted-foreground">
                                    <span className="font-medium text-foreground">{d.engine}:</span> {d.issue}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {onRelatedAction && (
                <div className="pt-2">
                  <Button
                    className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold"
                    disabled={selectedCount === 0}
                    onClick={handleGenerateSelected}
                  >
                    {selectedCount === 0
                      ? "Select pages to act on"
                      : `Act on ${selectedCount} selected page${selectedCount > 1 ? "s" : ""}`}
                  </Button>
                  {selectedCount > 1 && (
                    <p className="text-xs text-muted-foreground text-center mt-1">
                      Pages will be generated one at a time — you'll be returned here after each.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Add to your site */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <p className="text-sm font-semibold text-foreground">Add this page to your website</p>
          <p className="text-xs text-muted-foreground mt-0.5">Choose how you want to use this content.</p>
        </div>
        <div className="p-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <button
            onClick={sendToDeveloper}
            className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 px-3 py-4 text-center transition-colors group"
          >
            <Mail className="w-5 h-5 text-accent group-hover:scale-105 transition-transform" />
            <span className="text-xs font-medium text-foreground leading-tight">Email my<br/>developer</span>
          </button>
          <button
            onClick={downloadHtml}
            className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 px-3 py-4 text-center transition-colors group"
          >
            <Download className="w-5 h-5 text-accent group-hover:scale-105 transition-transform" />
            <span className="text-xs font-medium text-foreground leading-tight">Download<br/>HTML file</span>
          </button>
          <button
            onClick={copyRichText}
            className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 px-3 py-4 text-center transition-colors group"
          >
            {copiedRichText
              ? <Check className="w-5 h-5 text-green-500" />
              : <Copy className="w-5 h-5 text-accent group-hover:scale-105 transition-transform" />}
            <span className="text-xs font-medium text-foreground leading-tight">Copy formatted<br/>text</span>
          </button>
          <button
            onClick={copyHtml}
            className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 px-3 py-4 text-center transition-colors group"
          >
            {copiedHtml
              ? <Check className="w-5 h-5 text-green-500" />
              : <Copy className="w-5 h-5 text-accent group-hover:scale-105 transition-transform" />}
            <span className="text-xs font-medium text-foreground leading-tight">Copy<br/>HTML code</span>
          </button>
        </div>

        {/* CMS instructions toggle */}
        <div className="border-t border-border">
          <button
            onClick={() => setShowCmsInstructions(v => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <span>How do I add this to my site?</span>
            {showCmsInstructions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showCmsInstructions && (
            <div className="px-5 pb-5 space-y-4">
              {/* CMS tabs */}
              <div className="flex gap-1 bg-muted/40 rounded-lg p-1">
                {(["wordpress", "wix", "squarespace", "webflow"] as const).map(cms => (
                  <button
                    key={cms}
                    onClick={() => setActiveCms(cms)}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                      activeCms === cms
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {cms === "squarespace" ? "Squarespace" : cms.charAt(0).toUpperCase() + cms.slice(1)}
                  </button>
                ))}
              </div>

              {activeCms === "wordpress" && (
                <ol className="space-y-3 text-sm text-foreground">
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">1</span><span>In your WordPress dashboard, go to <strong>Pages → Add New Page</strong>.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">2</span><span>Click the <strong>"+"</strong> button in the editor, search for <strong>Custom HTML</strong>, and add that block.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">3</span><span>Click <strong>"Copy HTML code"</strong> above and paste it into the Custom HTML block.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">4</span><span><strong>For the schema markup</strong> (helps Google): copy the code from the <strong>JSON-LD Schema</strong> tab. In Yoast SEO or RankMath, find the Schema settings for this page and paste it there.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">5</span><span>Set the page URL (slug) to something like <strong>/services/{keyword.replace(/\s+/g, "-").toLowerCase()}</strong>, then click <strong>Publish</strong>.</span></li>
                </ol>
              )}

              {activeCms === "wix" && (
                <ol className="space-y-3 text-sm text-foreground">
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">1</span><span>In the Wix Editor, click <strong>Add (+) → Embed Code → Embed HTML</strong>.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">2</span><span>Click <strong>"Copy HTML code"</strong> above and paste it into the embed box.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">3</span><span>Alternatively, click <strong>"Copy formatted text"</strong> and paste directly into a Wix <strong>Text</strong> element — the headings and paragraphs will paste with their formatting.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">4</span><span><strong>For the schema markup</strong>: in Wix, go to <strong>SEO → Advanced SEO → Structured Data Markup</strong> and paste the code from the JSON-LD Schema tab.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">5</span><span>Publish the page.</span></li>
                </ol>
              )}

              {activeCms === "squarespace" && (
                <ol className="space-y-3 text-sm text-foreground">
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">1</span><span>In Squarespace, go to <strong>Pages</strong> and add a new <strong>Blank Page</strong>.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">2</span><span>Click <strong>Edit</strong>, then add a <strong>Code Block</strong> (click + → More → Code).</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">3</span><span>Click <strong>"Copy HTML code"</strong> above and paste it into the code block. Make sure <strong>"Display Source"</strong> is turned off.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">4</span><span><strong>For the schema markup</strong>: go to the page's <strong>Settings → Advanced → Page Header Code Injection</strong> and paste the code from the JSON-LD Schema tab.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">5</span><span>Save and publish.</span></li>
                </ol>
              )}

              {activeCms === "webflow" && (
                <ol className="space-y-3 text-sm text-foreground">
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">1</span><span>In Webflow Designer, add a new page or open an existing one.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">2</span><span>From the Components panel, drag an <strong>Embed</strong> element onto the page.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">3</span><span>Click <strong>"Copy HTML code"</strong> above and paste it into the embed editor, then click Save &amp; Close.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">4</span><span><strong>For the schema markup</strong>: go to <strong>Page Settings → Custom Code → Head Code</strong> and paste the code from the JSON-LD Schema tab.</span></li>
                  <li className="flex gap-3"><span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-semibold">5</span><span>Publish your site.</span></li>
                </ol>
              )}

              <p className="text-xs text-muted-foreground pt-1">
                Not sure? Use <strong>"Email my developer"</strong> above — it writes the email for you. Just download the HTML file and attach it.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Save + navigation */}
      <div className="bg-card rounded-xl border border-border p-5 space-y-3">
        {saveError && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{saveError}</div>
        )}
        <Button
          className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold"
          onClick={savePage}
          disabled={saving || saved}
        >
          {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</>
            : saved ? <><Check className="w-4 h-4 mr-2" /> Saved to ShowUP</>
            : <><Save className="w-4 h-4 mr-2" /> Save Page</>}
        </Button>
        <button onClick={onNewPage} className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors text-center">
          ← Start new keyword analysis
        </button>
      </div>
    </div>
  );
}
