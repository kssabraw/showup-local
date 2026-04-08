import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check, Save, Loader2, ExternalLink, Download, TrendingUp, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { nlp } from "@/lib/nlp-client";
import { StepIndicator } from "@/components/StepIndicator";
import { useInvalidateSavedPages } from "@/hooks/useSavedPages";
import type { RelatedPageItem, ScoreResult } from "@/lib/nlp-types";
import DOMPurify from 'dompurify';

import type { TokenUsage, CostBreakdown } from "@/lib/nlp-types";

function formatHtml(html: string): string {
  const INDENT = '  ';

  const BLOCK = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'div', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'blockquote', 'pre', 'figure', 'figcaption', 'script', 'style',
    'form', 'fieldset', 'details', 'summary',
  ]);

  // These get a blank line prepended to visually separate sections
  const SPACER = new Set([
    'section', 'article', 'header', 'footer', 'nav', 'main', 'aside',
    'div', 'table', 'ul', 'ol', 'blockquote', 'figure',
    'h1', 'h2', 'h3',
  ]);

  const VOID = new Set([
    'br', 'hr', 'img', 'input', 'link', 'meta',
    'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr',
  ]);

  function serialize(node: Node, depth: number): string {
    // Text node
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text ? INDENT.repeat(depth) + text : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const attrs = Array.from(el.attributes).map(a => ` ${a.name}="${a.value}"`).join('');
    const pad = INDENT.repeat(depth);
    const spacer = SPACER.has(tag) ? '\n' : '';

    // Void elements — no children, no closing tag
    if (VOID.has(tag)) return `${spacer}${pad}<${tag}${attrs}>`;

    const children = Array.from(el.childNodes);
    const hasBlockChild = children.some(
      c => c.nodeType === Node.ELEMENT_NODE && BLOCK.has((c as Element).tagName.toLowerCase())
    );

    // No block children → keep content on one line (preserves inline formatting)
    if (!hasBlockChild) {
      const inner = el.innerHTML.replace(/\s+/g, ' ').trim();
      return `${spacer}${pad}<${tag}${attrs}>${inner}</${tag}>`;
    }

    // Block children → indent each child on its own line
    const childLines = children
      .map(c => serialize(c, depth + 1))
      .filter(s => s.trim() !== '');
    return `${spacer}${pad}<${tag}${attrs}>\n${childLines.join('\n')}\n${pad}</${tag}>`;
  }

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const lines = Array.from(doc.body.childNodes)
    .map(n => serialize(n, 0))
    .filter(s => s.trim() !== '');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface ContentGap {
  category: string;
  missing: string;
  score_impact: "high" | "medium" | "low";
  why_important: string;
  how_to_add: string;
}

interface Props {
  keyword: string;
  location: string;
  mode: "generate" | "reoptimize";
  isNew?: boolean;
  contentHtml: string;
  schemaJson: string;
  pageTitle: string;
  htmlCssNotes?: string[];
  contentGaps?: ContentGap[];
  tokenUsage: Partial<TokenUsage>;
  costBreakdown?: Partial<CostBreakdown>;
  businessId: string;
  businessName: string;
  website?: string;
  gbpCategory: string;
  address: string;
  phone?: string;
  differentiators?: unknown[];
  detected_icp?: unknown;
  brand_voice?: unknown;
  serp_analysis?: unknown;
  prevScore?: number | null;
  initialScore?: number | null;
  /** ID of the already-saved DB row (if any) — used to persist social posts */
  savedPageId?: string | null;
  /** Pre-loaded social posts from DB — skip generation if provided */
  initialSocialPosts?: { gbp: string[] } | null;
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

function scoreStatus(score: number): string {
  if (score >= 90) return "excellent";
  if (score >= 80) return "good";
  if (score >= 70) return "needs_improvement";
  if (score >= 60) return "below_standard";
  return "fail";
}

export default function GeneratedPageView({
  keyword, location, mode, isNew, contentHtml, schemaJson, pageTitle, htmlCssNotes, contentGaps,
  tokenUsage, costBreakdown,
  businessId, businessName, website, gbpCategory, address,
  phone, differentiators, detected_icp, brand_voice, serp_analysis,
  prevScore, initialScore, savedPageId: savedPageIdProp, initialSocialPosts,
  onBack, onNewPage, onRelatedAction,
}: Props) {
  const invalidateSavedPages = useInvalidateSavedPages();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [copiedRichText, setCopiedRichText] = useState(false);
  const [showCostBreakdown, setShowCostBreakdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!savedPageIdProp);
  const [saveError, setSaveError] = useState("");

  // Rich-text div ref — set innerHTML via effect to avoid React reconciliation issues
  const richTextRef = useRef<HTMLDivElement>(null);

  // Score display — seed from the generation response if available (avoids a second API call)
  const [autoScore, setAutoScore] = useState<ScoreResult | null>(
    initialScore != null
      ? ({ composite_score: initialScore, composite_status: scoreStatus(initialScore) } as ScoreResult)
      : null
  );
  // Auto-score only for newly generated pages (isNew=true). Saved pages already
  // have their score stored in the DB — we show it via initialScore and never
  // re-run scoring automatically.
  const [autoScoring, setAutoScoring] = useState(isNew === true && initialScore == null);
  const [scoreFailed, setScoreFailed] = useState(false);
  const scoredRef = useRef(false);

  useEffect(() => {
    // Only auto-score on newly generated pages
    if (!isNew) return;
    // Skip if generation already returned a score
    if (initialScore != null) return;
    if (scoredRef.current) return;
    scoredRef.current = true;
    nlp.scorePage({
      keyword,
      location,
      page_content: contentHtml,
      business_name: businessName,
      gbp_category: gbpCategory,
      address,
      serp_analysis: serp_analysis as any,
    }).then(result => {
      setAutoScore(result);
    }).catch(() => {
      setScoreFailed(true);
    }).finally(() => {
      setAutoScoring(false);
    });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [activeTab, setActiveTab] = useState<"preview" | "raw-text" | "html" | "social" | "related">("preview");
  // Related pages state
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedItems, setRelatedItems] = useState<RelatedPageItem[] | null>(null);
  const [relatedError, setRelatedError] = useState("");
  // Social posts state — seed from DB if already saved
  const [socialPosts, setSocialPosts] = useState<{ gbp: string[] } | null>(initialSocialPosts ?? null);
  const [socialLoading, setSocialLoading] = useState(false);
  // Track which DB row to update with social posts once generated
  const savedPageIdRef = useRef<string | null>(savedPageIdProp ?? null);
  const [copiedPost, setCopiedPost] = useState<string | null>(null);
  const [selections, setSelections] = useState<RelatedSelection>({});

  const copyHtml = async () => {
    const fullHtml = pageTitle ? `<title>${pageTitle}</title>\n\n${formatHtml(contentHtml)}` : formatHtml(contentHtml);
    await navigator.clipboard.writeText(fullHtml);
    setCopiedHtml(true);
    setTimeout(() => setCopiedHtml(false), 2000);
  };

  const copyRichText = async () => {
    const el = richTextRef.current;
    if (!el) {
      setCopiedRichText(true);
      setTimeout(() => setCopiedRichText(false), 2000);
      return;
    }

    // Build full HTML — title note + content body
    const titleHtml = pageTitle
      ? `<p><strong>SEO Title:</strong> ${pageTitle}</p><hr>`
      : "";
    const fullHtml = titleHtml + el.innerHTML;
    const fullText = pageTitle
      ? `SEO Title: ${pageTitle}\n\n${el.innerText}`
      : el.innerText;

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([fullHtml], { type: "text/html" }),
          "text/plain": new Blob([fullText], { type: "text/plain" }),
        }),
      ]);
    } catch {
      // execCommand fallback — temporarily inject title into the div, select all, copy, restore
      const titleNode = document.createElement("div");
      titleNode.innerHTML = titleHtml;
      el.insertBefore(titleNode, el.firstChild);
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      try { document.execCommand("copy"); } catch { /* ignore */ }
      sel?.removeAllRanges();
      el.removeChild(titleNode);
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
      const { data: saved, error } = await supabase.from("generated_pages").insert({
        business_id: businessId,
        keyword,
        location,
        mode,
        page_title: pageTitle || null,
        content_html: contentHtml,
        schema_json: schemaJson || null,
        composite_score: autoScore?.composite_score ?? null,
        composite_status: autoScore?.composite_status ?? null,
        social_posts: socialPosts ?? null,
        content_gaps: contentGaps ?? [],
      }).select("id").single();
      if (error) throw error;
      // Track the row ID so fetchSocialPosts can update it if posts arrive later
      if (saved?.id) savedPageIdRef.current = saved.id;
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

  // Populate the contentEditable rich-text div whenever the tab is active
  useEffect(() => {
    if (activeTab === "raw-text" && richTextRef.current) {
      richTextRef.current.innerHTML = DOMPurify.sanitize(contentHtml);
    }
  }, [activeTab, contentHtml]);

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
        phone,
        page_content: pageText,
        differentiators,
        detected_icp,
        brand_voice,
        serp_analysis,
      });
      const posts = { gbp: data.gbp };
      setSocialPosts(posts);
      // Persist to DB so we don't regenerate on next view
      if (savedPageIdRef.current) {
        supabase
          .from("generated_pages")
          .update({ social_posts: posts })
          .eq("id", savedPageIdRef.current)
          .then(() => {});  // fire-and-forget
      }
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
    const text = `GBP POSTS\n${"─".repeat(40)}\n${socialPosts.gbp.map((p, i) => `${i + 1}. ${p}`).join("\n\n")}`;
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

  const wordCount = (contentHtml ?? "")
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

      {/* SEO Score banner */}
      {autoScoring ? (
        <div className="flex items-center gap-2 px-4 py-3 bg-muted/40 border border-border rounded-xl text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          Scoring your page…
        </div>
      ) : scoreFailed ? (
        <div className="flex items-center gap-2 px-4 py-3 bg-muted/40 border border-border rounded-xl text-sm text-muted-foreground">
          Score unavailable — the scoring service didn't respond. Your page was still generated successfully.
        </div>
      ) : autoScore ? (
        <div className={`flex items-center gap-4 px-5 py-4 rounded-xl border ${
          autoScore.composite_score >= 80 ? "bg-green-500/5 border-green-500/20" :
          autoScore.composite_score >= 60 ? "bg-amber-500/5 border-amber-500/20" :
          "bg-red-500/5 border-red-500/20"
        }`}>
          <TrendingUp className={`w-5 h-5 shrink-0 ${
            autoScore.composite_score >= 80 ? "text-green-500" :
            autoScore.composite_score >= 60 ? "text-amber-500" :
            "text-red-500"
          }`} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">SEO Score</p>
            {mode === "reoptimize" && prevScore != null ? (
              <div className="flex items-center gap-2">
                <span className="text-xl font-display font-bold text-muted-foreground">{Math.round(prevScore)}</span>
                <ArrowRight className="w-4 h-4 text-muted-foreground" />
                <span className={`text-xl font-display font-bold ${
                  autoScore.composite_score >= 80 ? "text-green-500" :
                  autoScore.composite_score >= 60 ? "text-amber-500" :
                  "text-red-500"
                }`}>{Math.round(autoScore.composite_score)}</span>
                <span className="text-sm text-muted-foreground">/ 100</span>
                {autoScore.composite_score > prevScore && (
                  <span className="text-xs font-medium text-green-600 bg-green-500/10 px-2 py-0.5 rounded-full">
                    +{Math.round(autoScore.composite_score - prevScore)} pts
                  </span>
                )}
              </div>
            ) : (
              <div className="flex items-baseline gap-1.5">
                <span className={`text-xl font-display font-bold ${
                  autoScore.composite_score >= 80 ? "text-green-500" :
                  autoScore.composite_score >= 60 ? "text-amber-500" :
                  "text-red-500"
                }`}>{Math.round(autoScore.composite_score)}</span>
                <span className="text-sm text-muted-foreground">/ 100</span>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground capitalize hidden sm:block">{autoScore.composite_status?.replace("_", " ")}</p>
        </div>
      ) : null}

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
        {(["preview", "raw-text", "html", "social", "related"] as const).map(tab => (
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
                ? <span className="flex items-center gap-1.5">GBP Posts {socialLoading && <Loader2 className="w-3 h-3 animate-spin" />}</span>
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

          {/* Content gaps — facts we couldn't verify/include */}
          {contentGaps && contentGaps.length > 0 && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="bg-muted/40 px-5 py-4 border-b border-border">
                <p className="text-sm font-semibold text-foreground">How to reach 100/100</p>
                <p className="text-xs text-muted-foreground mt-1">
                  The following facts would improve your score but couldn't be included because they weren't
                  verified from your business data. Add them to your Google Business Profile or website,
                  then regenerate the page.
                </p>
              </div>
              <div className="divide-y divide-border">
                {contentGaps.map((gap, i) => (
                  <div key={i} className="px-5 py-4 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        gap.score_impact === "high"
                          ? "bg-red-500/10 text-red-500"
                          : gap.score_impact === "medium"
                          ? "bg-amber-500/10 text-amber-500"
                          : "bg-muted text-muted-foreground"
                      }`}>
                        {gap.score_impact === "high" ? "High impact" : gap.score_impact === "medium" ? "Medium impact" : "Low impact"}
                      </span>
                      <span className="text-sm font-medium text-foreground">{gap.category}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{gap.missing}</p>
                    <p className="text-xs text-foreground/70"><span className="font-medium">Why it matters:</span> {gap.why_important}</p>
                    <p className="text-xs text-foreground/70"><span className="font-medium">How to add it:</span> {gap.how_to_add}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Raw Text tab — WordPress-ready rich text */}
      {activeTab === "raw-text" && (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">WordPress-Ready Rich Text</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Click <span className="font-medium">Copy for WordPress</span>, then paste into your editor — headings, lists, bold, and tables are preserved.
              </p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0" onClick={copyRichText}>
              {copiedRichText ? <><Check className="w-4 h-4 mr-1" /> Copied!</> : <><Copy className="w-4 h-4 mr-1" /> Copy for WordPress</>}
            </Button>
          </div>

          {/* WordPress paste instructions */}
          <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg px-4 py-3 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground mb-1">Where to paste in WordPress:</p>
            <p><span className="font-medium text-foreground">Gutenberg (block editor)</span> — Add a <span className="font-mono bg-muted px-1 rounded">Classic</span> block, then paste. Or add a <span className="font-mono bg-muted px-1 rounded">Custom HTML</span> block and use the HTML tab instead.</p>
            <p><span className="font-medium text-foreground">Classic editor</span> — Open the Visual tab, then paste.</p>
          </div>

          {pageTitle && (
            <div className="flex items-start gap-3 px-4 py-3 bg-muted/40 rounded-lg border border-border">
              <span className="text-xs font-mono text-muted-foreground shrink-0 mt-0.5">&lt;title&gt;</span>
              <span className="text-sm text-foreground">{pageTitle}</span>
            </div>
          )}

          {/* contentEditable div — browser copies genuine rich text on Ctrl+C or execCommand */}
          <div
            ref={richTextRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            className="bg-white rounded-xl border border-border p-8 prose prose-sm max-w-none
                       prose-headings:text-gray-900 prose-p:text-gray-800 prose-li:text-gray-800
                       prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
                       prose-headings:font-bold prose-strong:font-bold
                       focus:outline-none focus:ring-2 focus:ring-accent/30 cursor-text"
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
            {pageTitle ? `<title>${pageTitle}</title>\n\n` : ""}{formatHtml(contentHtml)}
          </pre>
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
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">GBP Posts</h3>
                  <span className="text-xs text-muted-foreground">Please add to your GBP</span>
                </div>
                <div className="space-y-2">
                  {socialPosts.gbp.map((post, i) => {
                    const id = `gbp-${i}`;
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
