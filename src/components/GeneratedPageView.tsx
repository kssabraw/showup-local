import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check, Save, Loader2, ExternalLink, Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { nlp } from "@/lib/nlp-client";
import { StepIndicator } from "@/components/StepIndicator";
import { useInvalidateSavedPages } from "@/hooks/useSavedPages";
import type { RelatedPageItem } from "@/lib/nlp-types";
import DOMPurify from 'dompurify';

import type { TokenUsage, CostBreakdown } from "@/lib/nlp-types";

interface Props {
  keyword: string;
  location: string;
  mode: "generate" | "reoptimize";
  contentHtml: string;
  schemaJson: string;
  pageTitle: string;
  htmlCssNotes?: string[];
  tokenUsage: Partial<TokenUsage>;
  costBreakdown?: Partial<CostBreakdown>;
  businessId: string;
  businessName: string;
  website?: string;
  gbpCategory: string;
  address: string;
  onBack: () => void;
  onNewPage: () => void;
  onRelatedAction?: (action: { mode: "reoptimize" | "new"; keyword: string; existingUrl?: string }) => void;
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
  const invalidateSavedPages = useInvalidateSavedPages();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [copiedRichText, setCopiedRichText] = useState(false);
  const [showCostBreakdown, setShowCostBreakdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [activeTab, setActiveTab] = useState<"preview" | "raw-text" | "html" | "schema" | "social" | "related">("preview");
  // Related pages state
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedItems, setRelatedItems] = useState<RelatedPageItem[] | null>(null);
  const [relatedError, setRelatedError] = useState("");
  // Social posts state
  const [socialPosts, setSocialPosts] = useState<{ gbp: string[]; facebook: string[]; instagram: string[]; pinterest: string[] } | null>(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [copiedPost, setCopiedPost] = useState<string | null>(null);
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
      invalidateSavedPages(); // refresh saved pages list + dashboard stats
    } catch (e: any) {
      setSaveError((e as Error).message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const fetchRelatedPages = async () => {
    setRelatedLoading(true);
    setRelatedError("");
    setRelatedItems(null);
    try {
      const data = await nlp.relatedPages({
        keyword,
        location,
        business_name: businessName,
        gbp_category: gbpCategory,
        address,
        website: website || null,
      });
      setRelatedItems(data.items ?? []);
    } catch (e: any) {
      setRelatedError((e as Error).message || "Failed to load related pages");
    } finally {
      setRelatedLoading(false);
    }
  };

  // Start fetching related pages + social posts in the background on mount
  useEffect(() => {
    fetchRelatedPages();
    fetchSocialPosts();
  }, []);

  const fetchSocialPosts = async () => {
    if (socialLoading || socialPosts) return;
    setSocialLoading(true);
    try {
      const pageText = new DOMParser()
        .parseFromString(contentHtml, "text/html")
        .body.innerText;
      const data = await nlp.generateSocialPosts({
        keyword,
        location,
        business_name: businessName,
        gbp_category: gbpCategory,
        address,
        page_content: pageText,
      });
      setSocialPosts({ gbp: data.gbp, facebook: data.facebook, instagram: data.instagram, pinterest: data.pinterest });
    } catch {
      // Non-fatal — social tab will show a retry button
    } finally {
      setSocialLoading(false);
    }
  };

  const copyPost = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedPost(id);
    setTimeout(() => setCopiedPost(null), 2000);
  };

  const downloadSocialPosts = () => {
    if (!socialPosts) return;
    const platforms = [
      { label: "GBP Posts", posts: socialPosts.gbp },
      { label: "Facebook Posts", posts: socialPosts.facebook },
      { label: "Instagram Posts", posts: socialPosts.instagram },
      { label: "Pinterest Posts", posts: socialPosts.pinterest },
    ];
    const text = platforms.map(({ label, posts }) =>
      `${label.toUpperCase()}\n${"─".repeat(40)}\n${posts.map((p, i) => `${i + 1}. ${p}`).join("\n\n")}`
    ).join("\n\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${keyword.replace(/\s+/g, "-")}-social-posts.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

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
            { label: "Search data", value: costBreakdown?.dataforseo },
            { label: `Page analysis (${costBreakdown?.scrapeowl_pages ?? 0} pages)`, value: costBreakdown?.scrapeowl },
            { label: `Content analysis (${((costBreakdown?.google_nlp_chars ?? 0) / 1000).toFixed(0)}k chars)`, value: costBreakdown?.google_nlp },
            { label: `${costBreakdown?.claude_model?.includes("haiku") ? "Keyword research" : "Page generation"} (${costBreakdown?.claude_input_tokens ?? 0}+${costBreakdown?.claude_output_tokens ?? 0} tokens)`, value: costBreakdown?.claude },
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
        {(["preview", "raw-text", "html", "schema", "social", "related"] as const).map(tab => (
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
              : tab === "social"
                ? <span className="flex items-center gap-1.5">Social Posts {socialLoading && <Loader2 className="w-3 h-3 animate-spin" />}</span>
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
          <div
            className="bg-card rounded-xl border border-border p-8 prose prose-sm max-w-none
                       prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground
                       prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(contentHtml.replace(/<\/p>\s*<p/g, '</p><br><br><p')) }}
          />
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
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(contentHtml) }}
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

      {/* Social Posts tab */}
      {activeTab === "social" && (
        <div className="space-y-6">
          {socialLoading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="text-sm">Generating 20 social posts…</p>
            </div>
          )}
          {!socialLoading && !socialPosts && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
              <p className="text-sm">Social posts could not be generated.</p>
              <Button variant="outline" size="sm" onClick={fetchSocialPosts}>Retry</Button>
            </div>
          )}
          {socialPosts && (
            <>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={downloadSocialPosts}>
                  <Download className="w-4 h-4 mr-1.5" /> Download All
                </Button>
              </div>
              {([
                { key: "gbp",       label: "GBP Posts",       wordLimit: "≤200 words" },
                { key: "facebook",  label: "Facebook Posts",  wordLimit: "≤200 words" },
                { key: "instagram", label: "Instagram Posts", wordLimit: "≤50 words" },
                { key: "pinterest", label: "Pinterest Posts", wordLimit: "≤50 words" },
              ] as const).map(({ key, label, wordLimit }) => (
                <div key={key} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{label}</h3>
                    <span className="text-xs text-muted-foreground">{wordLimit}</span>
                  </div>
                  <div className="space-y-2">
                    {socialPosts[key].map((post, i) => {
                      const id = `${key}-${i}`;
                      return (
                        <div key={id} className="bg-card rounded-lg border border-border p-4 flex gap-3">
                          <span className="text-xs font-semibold text-muted-foreground w-4 shrink-0 mt-0.5">{i + 1}</span>
                          <p className="text-sm text-foreground flex-1 whitespace-pre-wrap">{post}</p>
                          <button
                            onClick={() => copyPost(post, id)}
                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                            title="Copy"
                          >
                            {copiedPost === id ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
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

      {/* Actions */}
      <div className="bg-card rounded-xl border border-border p-6 space-y-3">
        {saveError && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{saveError}</div>
        )}
        <div className="flex gap-3">
          <Button
            className="flex-1 bg-accent text-accent-foreground hover:opacity-90 font-semibold"
            onClick={savePage}
            disabled={saving || saved}
          >
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</>
              : saved ? <><Check className="w-4 h-4 mr-2" /> Saved</>
              : <><Save className="w-4 h-4 mr-2" /> Save Page</>}
          </Button>
          <Button variant="outline" onClick={copyHtml} className="flex-1">
            {copiedHtml ? <><Check className="w-4 h-4 mr-1" /> Copied</> : <><Copy className="w-4 h-4 mr-1" /> Copy HTML</>}
          </Button>
        </div>
        <button onClick={onNewPage} className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors text-center">
          ← Start new keyword analysis
        </button>
      </div>
    </div>
  );
}
