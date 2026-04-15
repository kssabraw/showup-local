import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Check, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";
import { nlp } from "@/lib/nlp-client";
import DOMPurify from "dompurify";
import type { ReoptimizeResult } from "@/lib/nlp-types";

// ── Section parsing ───────────────────────────────────────────────────────────

interface HtmlSection {
  heading: string;
  html: string;
}

function parseIntoSections(html: string): HtmlSection[] {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.querySelector("div");
  if (!root) return [{ heading: "Content", html }];

  const sections: HtmlSection[] = [];
  let heading = "Introduction";
  let nodes: ChildNode[] = [];

  function flush() {
    const buf = document.createElement("div");
    nodes.forEach(n => buf.appendChild(n.cloneNode(true)));
    const inner = buf.innerHTML.trim();
    if (inner) sections.push({ heading, html: inner });
    nodes = [];
  }

  for (const node of Array.from(root.childNodes)) {
    const el = node as Element;
    if (el.nodeType === Node.ELEMENT_NODE && el.tagName === "H2") {
      flush();
      heading = el.textContent?.trim() ?? "";
    }
    nodes.push(node);
  }
  flush();

  return sections;
}

function getPlainText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(html);
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
}

function normalizeHeading(h: string) {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Rough word-overlap ratio to detect whether two text blocks differ substantially. */
function similarityRatio(a: string, b: string): number {
  const wordsA = new Set(a.slice(0, 400).split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.slice(0, 400).split(/\s+/).filter(Boolean));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 1 : intersection / union;
}

// ── Diff state ────────────────────────────────────────────────────────────────

interface DiffSection {
  heading: string;
  originalHtml: string;
  rewrittenHtml: string;
  changed: boolean;
  choice: "rewrite" | "original";
  regenerating: boolean;
  customHtml?: string;
}

function buildDiff(original: HtmlSection[], rewritten: HtmlSection[]): DiffSection[] {
  const origMap = new Map(original.map(s => [normalizeHeading(s.heading), s]));

  return rewritten.map(rSec => {
    const key = normalizeHeading(rSec.heading);
    const oSec = origMap.get(key);
    const originalHtml = oSec?.html ?? "";
    const origText = getPlainText(originalHtml);
    const newText = getPlainText(rSec.html);
    const changed = !oSec || similarityRatio(origText, newText) < 0.95;
    return {
      heading: rSec.heading,
      originalHtml,
      rewrittenHtml: rSec.html,
      changed,
      choice: "rewrite" as const,
      regenerating: false,
    };
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  result: ReoptimizeResult;
  originalHtml: string;
  keyword: string;
  location: string;
  businessName: string;
  gbpCategory: string;
  address: string;
  phone?: string;
  deficiencies: Array<{
    engine: string;
    engine_key: string;
    score: number;
    issues: string[];
    recommendations: string[];
  }>;
  prevScore: number;
  onApply: (
    contentHtml: string,
    schemaJson: string,
    pageTitle: string,
    tokenUsage: ReoptimizeResult["token_usage"],
  ) => void;
  onBack: () => void;
}

export default function ImproveDiffView({
  result, originalHtml, keyword, location, businessName, gbpCategory, address, phone,
  deficiencies, onApply, onBack,
}: Props) {
  const originalSections = parseIntoSections(originalHtml);
  const rewrittenSections = parseIntoSections(result.content_html);

  const [sections, setSections] = useState<DiffSection[]>(() =>
    buildDiff(originalSections, rewrittenSections)
  );
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const changedSections = sections.filter(s => s.changed);
  const acceptedCount = changedSections.filter(s => s.choice === "rewrite").length;

  const toggleExpand = (heading: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(heading) ? next.delete(heading) : next.add(heading);
      return next;
    });
  };

  const setChoice = (heading: string, choice: "rewrite" | "original") => {
    setSections(prev => prev.map(s => s.heading === heading ? { ...s, choice } : s));
  };

  const acceptAll = () => setSections(prev => prev.map(s => ({ ...s, choice: "rewrite" as const })));
  const rejectAll = () => setSections(prev => prev.map(s => ({ ...s, choice: "original" as const })));

  const regenerateSection = async (heading: string) => {
    const section = sections.find(s => s.heading === heading);
    if (!section) return;

    // Best-match deficiency for this section heading, fall back to first
    const headingLower = heading.toLowerCase();
    const deficiency = deficiencies.find(d => {
      if (d.engine_key === "aeo_llm_retrieval" && headingLower.includes("faq")) return true;
      if (d.engine_key === "geographic_legitimacy" && (headingLower.includes("area") || headingLower.includes("location"))) return true;
      if (d.engine_key === "nearme_intent" && (headingLower.includes("emergency") || headingLower.includes("urgency"))) return true;
      if (d.engine_key === "icp_alignment" && headingLower.includes("cta")) return true;
      return false;
    }) ?? deficiencies[0];

    setSections(prev => prev.map(s => s.heading === heading ? { ...s, regenerating: true } : s));

    try {
      const res = await nlp.reoptimizeSection({
        section_html: section.originalHtml || section.rewrittenHtml,
        engine: deficiency?.engine_key ?? "organic_ranking",
        issues: deficiency?.issues ?? [],
        recommendations: deficiency?.recommendations ?? [],
        keyword,
        location,
        business_name: businessName,
        gbp_category: gbpCategory,
        address,
        phone,
      });
      setSections(prev => prev.map(s =>
        s.heading === heading
          ? { ...s, regenerating: false, customHtml: res.section_html, choice: "rewrite" }
          : s
      ));
    } catch {
      setSections(prev => prev.map(s =>
        s.heading === heading ? { ...s, regenerating: false } : s
      ));
    }
  };

  const apply = () => {
    const finalHtml = sections
      .map(s => {
        if (s.choice === "original" && s.originalHtml) return s.originalHtml;
        return s.customHtml ?? s.rewrittenHtml;
      })
      .join("\n");
    onApply(finalHtml, result.schema_json, result.page_title ?? "", result.token_usage);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <button
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors"
        >
          ← Back to score
        </button>
        <h1 className="text-2xl font-display font-bold text-foreground">Review Improvements</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {changedSections.length} section{changedSections.length !== 1 ? "s" : ""} rewritten.
          {" "}Review each change and accept or keep the original.
        </p>
      </div>

      {/* No changes edge case */}
      {changedSections.length === 0 && (
        <div className="bg-card rounded-xl border border-border p-6 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            The rewrite produced no detectable section changes. You can still apply it to use the improved version.
          </p>
          <Button
            className="bg-accent text-accent-foreground hover:opacity-90 font-semibold"
            onClick={apply}
          >
            Apply Rewrite
          </Button>
        </div>
      )}

      {/* Summary bar */}
      {changedSections.length > 0 && (
        <div className="bg-card rounded-xl border border-border px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{acceptedCount}</span> of{" "}
            {changedSections.length} rewrites accepted
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={acceptAll}>Accept All</Button>
            <Button variant="outline" size="sm" onClick={rejectAll}>Keep All Original</Button>
          </div>
        </div>
      )}

      {/* Section list */}
      <div className="space-y-2">
        {sections.map(s => {
          const isExpanded = expandedSections.has(s.heading);
          const origText = getPlainText(s.originalHtml).slice(0, 600);
          const newText = getPlainText(s.customHtml ?? s.rewrittenHtml).slice(0, 600);

          return (
            <div
              key={s.heading}
              className={`rounded-xl border overflow-hidden transition-colors ${
                !s.changed
                  ? "border-border bg-muted/10"
                  : s.choice === "rewrite"
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-amber-500/30 bg-amber-500/5"
              }`}
            >
              {/* Row header */}
              <button
                className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-black/5 transition-colors"
                onClick={() => s.changed && toggleExpand(s.heading)}
                disabled={!s.changed}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  !s.changed ? "bg-muted" :
                  s.choice === "rewrite" ? "bg-green-500" : "bg-amber-500"
                }`} />
                <span className="flex-1 text-sm font-medium text-foreground truncate">
                  {s.heading || "Introduction"}
                </span>
                {!s.changed && (
                  <span className="text-xs text-muted-foreground">unchanged</span>
                )}
                {s.changed && (
                  <span className={`text-xs font-medium ${
                    s.choice === "rewrite" ? "text-green-600" : "text-amber-600"
                  }`}>
                    {s.choice === "rewrite" ? "Accepting rewrite" : "Keeping original"}
                  </span>
                )}
                {s.changed && (
                  isExpanded
                    ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                    : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                )}
              </button>

              {/* Expanded diff */}
              {s.changed && isExpanded && (
                <div className="border-t border-border">
                  <div className="grid grid-cols-2 divide-x divide-border text-xs">
                    <div className="p-4 space-y-1">
                      <p className="font-semibold text-muted-foreground uppercase tracking-wider mb-2">Original</p>
                      {origText
                        ? <p className="text-foreground/80 leading-relaxed whitespace-pre-wrap">{origText}{origText.length === 600 ? "…" : ""}</p>
                        : <p className="italic text-muted-foreground">Not present in original</p>
                      }
                    </div>
                    <div className="p-4 space-y-1">
                      <p className="font-semibold text-green-600 uppercase tracking-wider mb-2">
                        {s.customHtml ? "Regenerated" : "Rewritten"}
                      </p>
                      <p className="text-foreground/80 leading-relaxed whitespace-pre-wrap">
                        {newText}{newText.length === 600 ? "…" : ""}
                      </p>
                    </div>
                  </div>
                  {/* Actions */}
                  <div className="border-t border-border px-4 py-3 flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant={s.choice === "rewrite" ? "default" : "outline"}
                      className={s.choice === "rewrite" ? "bg-green-600 hover:bg-green-700 text-white" : ""}
                      onClick={() => setChoice(s.heading, "rewrite")}
                    >
                      <Check className="w-3.5 h-3.5 mr-1.5" />
                      Accept Rewrite
                    </Button>
                    <Button
                      size="sm"
                      variant={s.choice === "original" ? "default" : "outline"}
                      className={s.choice === "original" ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}
                      onClick={() => setChoice(s.heading, "original")}
                      disabled={!s.originalHtml}
                    >
                      Keep Original
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={s.regenerating}
                      onClick={() => regenerateSection(s.heading)}
                      className="ml-auto text-muted-foreground hover:text-foreground"
                      title="Regenerate this section only (no credit charge)"
                    >
                      {s.regenerating
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Regenerating…</>
                        : <><RotateCcw className="w-3.5 h-3.5 mr-1.5" />Regenerate</>
                      }
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Apply panel */}
      {changedSections.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-6 space-y-3">
          <p className="text-sm text-muted-foreground">
            {acceptedCount} rewrite{acceptedCount !== 1 ? "s" : ""} will be applied
            {changedSections.length - acceptedCount > 0
              ? ` · ${changedSections.length - acceptedCount} original${changedSections.length - acceptedCount !== 1 ? "s" : ""} kept`
              : ""}
            .
          </p>
          <Button
            className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6"
            onClick={apply}
          >
            Apply Changes &amp; Continue
          </Button>
          <button
            onClick={onBack}
            className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors text-center"
          >
            ← Back to score
          </button>
        </div>
      )}
    </div>
  );
}
