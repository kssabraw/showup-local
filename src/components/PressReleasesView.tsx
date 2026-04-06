import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, FileText, CheckCircle, RotateCcw, Download, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { nlp, purchasePressReleasePack, InsufficientPRCreditsError } from "@/lib/nlp-client";
import { useBusinessProfiles } from "@/hooks/useBusinessProfiles";
import { useGeneratedPages } from "@/hooks/useGeneratedPages";
import { useCredits } from "@/hooks/useCredits";
import {
  usePressReleases,
  usePressReleaseReports,
  useCreatePressRelease,
  useApprovePressRelease,
  useRequestChanges,
  type PressRelease,
} from "@/hooks/usePressReleases";
import PressReleaseFormModal, { type PressReleaseFormValues } from "@/components/PressReleaseFormModal";
import PressReleasePackModal, { type PRPackId, PR_PACKS } from "@/components/PressReleasePackModal";
import DOMPurify from "dompurify";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<PressRelease["status"], string> = {
  pending_user_approval: "Awaiting Your Approval",
  submitted: "Submitted for Syndication",
  syndicated: "Syndicated",
  report_uploaded: "Report Available",
};

const STATUS_COLOR: Record<PressRelease["status"], string> = {
  pending_user_approval: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  submitted: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  syndicated: "bg-green-500/10 text-green-600 border-green-500/20",
  report_uploaded: "bg-purple-500/10 text-purple-600 border-purple-500/20",
};

function StatusBadge({ status }: { status: PressRelease["status"] }) {
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_COLOR[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Flatten related_keywords JSON (all zones) into a deduplicated array of term strings. */
function extractRelatedKeywords(rk: unknown): string[] {
  if (!rk || typeof rk !== "object") return [];
  const zones = Object.values(rk as Record<string, unknown[]>);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const zone of zones) {
    if (!Array.isArray(zone)) continue;
    for (const item of zone) {
      const t = (item as { term?: string }).term;
      if (t && !seen.has(t)) { seen.add(t); terms.push(t); }
    }
  }
  // Sort by score desc
  const scored = zones.flat().filter(Boolean) as { term: string; score: number }[];
  const byTerm: Record<string, number> = {};
  for (const s of scored) if (s.term) byTerm[s.term] = Math.max(byTerm[s.term] ?? 0, s.score ?? 0);
  return terms.sort((a, b) => (byTerm[b] ?? 0) - (byTerm[a] ?? 0)).slice(0, 8);
}

function extractQuadgrams(tq: unknown): string[] {
  if (!Array.isArray(tq)) return [];
  return (tq as { phrase?: string }[]).map((q) => q.phrase ?? "").filter(Boolean).slice(0, 15);
}

function extractEntities(ge: unknown): string[] {
  if (!Array.isArray(ge)) return [];
  return (ge as { name?: string }[]).map((e) => e.name ?? "").filter(Boolean).slice(0, 15);
}

// ── Review sub-view ───────────────────────────────────────────────────────────

function PressReleaseReview({
  pr,
  business,
  onBack,
}: {
  pr: PressRelease;
  business: { website?: string | null; gbp_place_id?: string | null; gbp_category: string; address?: string | null; business_name: string } | undefined;
  onBack: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [showFormModal, setShowFormModal] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const approve = useApprovePressRelease();
  const requestChanges = useRequestChanges();
  const { data: reports } = usePressReleaseReports(pr.id);

  const handleApprove = async () => {
    await approve.mutateAsync(pr.id);
    onBack();
  };

  const handleRegenerateSubmit = async (values: PressReleaseFormValues) => {
    if (!feedback.trim()) return;
    setRegenerating(true);
    try {
      // Fetch analysis data and original page content in parallel
      const [analysisRes, pageRes] = await Promise.all([
        supabase
          .from("keyword_analyses")
          .select("related_keywords, top_quadgrams, google_entities")
          .eq("business_id", pr.business_id)
          .eq("keyword", pr.keyword)
          .eq("location", pr.location)
          .maybeSingle(),
        pr.generated_page_id
          ? supabase.from("generated_pages").select("content_html").eq("id", pr.generated_page_id).single()
          : Promise.resolve({ data: null }),
      ]);

      const analysis = analysisRes.data;
      const pageText = pageRes.data?.content_html
        ? new DOMParser().parseFromString(pageRes.data.content_html, "text/html").body.innerText.slice(0, 5000)
        : "";

      const result = await nlp.generatePressRelease({
        business_name: business?.business_name ?? "",
        website: business?.website ?? "",
        gbp_place_id: business?.gbp_place_id,
        address: business?.address,
        gbp_category: business?.gbp_category ?? "",
        keyword: pr.keyword,
        location: pr.location,
        page_content: pageText,
        related_keywords: extractRelatedKeywords(analysis?.related_keywords),
        entities: extractEntities(analysis?.google_entities),
        quadgrams: extractQuadgrams(analysis?.top_quadgrams),
        ...values,
      });

      await requestChanges.mutateAsync({
        id: pr.id,
        feedback: feedback.trim(),
        new_content_html: result.content_html,
      });

      setFeedback("");
      setShowFeedback(false);
    } finally {
      setRegenerating(false);
      setShowFormModal(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
          ← Back to Press Releases
        </button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">{pr.page_title || pr.keyword}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{pr.keyword} · {pr.location.split(",")[0]}</p>
          </div>
          <StatusBadge status={pr.status} />
        </div>
      </div>

      {/* Content */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Press Release</h2>
          <span className="text-xs text-muted-foreground">Generation #{pr.generation_count}</span>
        </div>
        <div className="px-6 py-5">
          {pr.content_html ? (
            <div
              className="prose prose-sm max-w-none text-foreground"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(pr.content_html) }}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="text-sm">Generating press release…</p>
            </div>
          )}
        </div>
      </div>

      {/* Previous feedback */}
      {pr.user_feedback && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-5 py-4">
          <p className="text-xs font-semibold text-amber-600 mb-1">Previous feedback</p>
          <p className="text-sm text-foreground">{pr.user_feedback}</p>
        </div>
      )}

      {/* Reports */}
      {reports && reports.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Syndication Reports</h2>
          </div>
          <div className="divide-y divide-border">
            {reports.map((report) => (
              <div key={report.id} className="px-6 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">{report.pdf_filename}</p>
                  <p className="text-xs text-muted-foreground">{new Date(report.uploaded_at).toLocaleDateString()}</p>
                </div>
                <button
                  onClick={async () => {
                    const { data, error } = await supabase.storage
                      .from("press-release-reports")
                      .createSignedUrl(report.pdf_url, 3600);
                    if (error || !data?.signedUrl) return;
                    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
                  }}
                  className="flex items-center gap-1.5 text-xs font-medium text-accent hover:opacity-80 transition-opacity"
                >
                  <Download className="w-3.5 h-3.5" /> Download
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {pr.status === "pending_user_approval" && pr.content_html && (
        <div className="bg-card border border-border rounded-xl p-6 space-y-3">
          <p className="text-sm text-muted-foreground">
            Review the press release above. Approve to submit for syndication, or request changes with feedback.
          </p>

          {!showFeedback ? (
            <div className="flex gap-3">
              <Button
                className="flex-1 bg-accent text-accent-foreground hover:opacity-90 font-semibold py-5"
                onClick={handleApprove}
                disabled={approve.isPending}
              >
                {approve.isPending
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…</>
                  : <><CheckCircle className="w-4 h-4 mr-2" /> Approve & Submit</>}
              </Button>
              <Button variant="outline" className="flex-1 font-semibold py-5" onClick={() => setShowFeedback(true)}>
                <RotateCcw className="w-4 h-4 mr-2" /> Request Changes
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <textarea
                className="w-full bg-background border border-border rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
                rows={4}
                placeholder="Describe what to improve — e.g. 'Focus more on the 24/7 availability' or 'Remove the pricing mention in paragraph 2'"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
              <div className="flex gap-3">
                <Button
                  className="flex-1 bg-accent text-accent-foreground hover:opacity-90 font-semibold py-5"
                  onClick={() => setShowFormModal(true)}
                  disabled={!feedback.trim() || regenerating}
                >
                  {regenerating
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Regenerating…</>
                    : "Regenerate with Feedback"}
                </Button>
                <Button variant="outline" className="font-semibold py-5" onClick={() => { setShowFeedback(false); setFeedback(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Re-gen form modal */}
      {showFormModal && (
        <PressReleaseFormModal
          defaultPageUrl={business?.website ?? ""}
          pageTitle={pr.page_title || pr.keyword}
          onSubmit={handleRegenerateSubmit}
          onClose={() => setShowFormModal(false)}
        />
      )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function PressReleasesView() {
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [reviewingPR, setReviewingPR] = useState<PressRelease | null>(null);
  const [showPackModal, setShowPackModal] = useState(false);
  const [showFormModal, setShowFormModal] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const { data: businesses = [], isLoading: businessesLoading } = useBusinessProfiles();
  const { data: pages = [], isLoading: pagesLoading } = useGeneratedPages(selectedBusinessId);
  const { data: pressReleases = [], isLoading: prsLoading } = usePressReleases(selectedBusinessId);
  const { data: credits } = useCredits();
  const createPR = useCreatePressRelease();

  const selectedBusiness = businesses.find((b) => b.id === selectedBusinessId);
  const selectedPage = pages.find((p) => p.id === selectedPageId);

  // Auto-select if only one business
  if (!selectedBusinessId && businesses.length === 1 && !businessesLoading) {
    setSelectedBusinessId(businesses[0].id);
  }

  const handlePackPurchase = async (pack: typeof PR_PACKS[number]) => {
    setPurchaseError(null);
    try {
      const result = await purchasePressReleasePack(pack.id);
      if (result.checkout_url) {
        window.location.href = result.checkout_url;
        return;
      }
      // Stripe not yet configured — proceed to generation
      setShowPackModal(false);
      setShowFormModal(true);
    } catch (err) {
      setPurchaseError(err instanceof Error ? err.message : "Purchase failed");
    }
  };

  const handleGenerate = async (values: PressReleaseFormValues) => {
    if (!selectedPageId || !selectedBusinessId || !selectedPage || !selectedBusiness) return;

    try {
    // Fetch analysis data for this page
    const { data: analysis } = await supabase
      .from("keyword_analyses")
      .select("related_keywords, top_quadgrams, google_entities")
      .eq("business_id", selectedBusinessId)
      .eq("keyword", selectedPage.keyword)
      .eq("location", selectedPage.location)
      .maybeSingle();

    // Fetch page content for context
    const { data: pageData } = await supabase
      .from("generated_pages")
      .select("content_html")
      .eq("id", selectedPageId)
      .single();

    const pageText = pageData?.content_html
      ? new DOMParser().parseFromString(pageData.content_html, "text/html").body.innerText.slice(0, 5000)
      : "";

    const result = await nlp.generatePressRelease({
      business_name: selectedBusiness.business_name,
      website: selectedBusiness.website ?? "",
      gbp_place_id: selectedBusiness.gbp_place_id,
      address: selectedBusiness.address,
      gbp_category: selectedBusiness.gbp_category,
      keyword: selectedPage.keyword,
      location: selectedPage.location,
      page_content: pageText,
      related_keywords: extractRelatedKeywords(analysis?.related_keywords),
      entities: extractEntities(analysis?.google_entities),
      quadgrams: extractQuadgrams(analysis?.top_quadgrams),
      ...values,
    });

    const pr = await createPR.mutateAsync({
      business_id: selectedBusinessId,
      generated_page_id: selectedPageId,
      keyword: selectedPage.keyword,
      location: selectedPage.location,
      page_title: selectedPage.page_title ?? selectedPage.keyword,
      content_html: result.content_html,
    });

    setSelectedPageId(null);
    setShowFormModal(false);
    setReviewingPR(pr);
    } catch (err) {
      if (err instanceof InsufficientPRCreditsError) {
        // Credit was already deducted server-side before the error surfaced here
        // (shouldn't happen — the proxy rejects before generation). Re-open pack modal.
        setShowFormModal(false);
        setPurchaseError("You have no press release credits. Purchase a pack to continue.");
        setShowPackModal(true);
      } else {
        setPurchaseError(err instanceof Error ? err.message : "Generation failed");
      }
    }
  };

  if (reviewingPR) {
    const latest = pressReleases.find((pr) => pr.id === reviewingPR.id) ?? reviewingPR;
    return (
      <PressReleaseReview
        pr={latest}
        business={selectedBusiness}
        onBack={() => setReviewingPR(null)}
      />
    );
  }

  return (
    <>
      <div className="max-w-3xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">Press Releases</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Generate a press release from any page and we'll syndicate it across news outlets.
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs text-muted-foreground">Press release credits</p>
            <p className={`text-lg font-bold ${(credits?.prCredits ?? 0) === 0 ? "text-destructive" : "text-foreground"}`}>
              {credits?.prCredits ?? 0}
            </p>
          </div>
        </div>

        {/* Business selector */}
        {businesses.length > 1 && (
          <div className="bg-card border border-border rounded-xl px-5 py-4">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-2">Business</label>
            <select
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
              value={selectedBusinessId ?? ""}
              onChange={(e) => { setSelectedBusinessId(e.target.value || null); setSelectedPageId(null); }}
            >
              <option value="">Select a business…</option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>{b.business_name}</option>
              ))}
            </select>
          </div>
        )}

        {businessesLoading && (
          <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">Loading…</span>
          </div>
        )}

        {selectedBusinessId && (
          <>
            {/* Generate new */}
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-border">
                <h2 className="text-sm font-semibold text-foreground">Generate New Press Release</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Select a page to generate a press release for</p>
              </div>

              {pagesLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">Loading pages…</span>
                </div>
              ) : pages.length === 0 ? (
                <div className="px-6 py-8 text-center text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No generated pages yet for {selectedBusiness?.business_name}.</p>
                  <p className="text-xs mt-1">Generate a page from the Content tab first.</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {pages.map((page) => (
                    <label key={page.id} className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-accent w-4 h-4 shrink-0"
                        checked={selectedPageId === page.id}
                        onChange={() => setSelectedPageId(selectedPageId === page.id ? null : page.id)}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{page.page_title || page.keyword}</p>
                        <p className="text-xs text-muted-foreground">
                          {page.keyword} · {page.location.split(",")[0]} · {new Date(page.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      {page.composite_score != null && (
                        <span className={`text-xs font-semibold shrink-0 ${
                          page.composite_score >= 80 ? "text-green-500"
                          : page.composite_score >= 60 ? "text-amber-500"
                          : "text-red-500"
                        }`}>
                          {page.composite_score}/100
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}

              {selectedPageId && (
                <div className="px-6 py-4 border-t border-border bg-muted/20">
                  <Button
                    className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-5"
                    onClick={() => { setPurchaseError(null); setShowPackModal(true); }}
                  >
                    <Send className="w-4 h-4 mr-2" /> Generate Press Release
                  </Button>
                </div>
              )}
            </div>

            {/* Existing press releases */}
            {(prsLoading || pressReleases.length > 0) && (
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-border">
                  <h2 className="text-sm font-semibold text-foreground">Your Press Releases</h2>
                </div>
                {prsLoading ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">Loading…</span>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {pressReleases.map((pr) => (
                      <div key={pr.id} className="px-6 py-4 flex items-center gap-4">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{pr.page_title || pr.keyword}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {pr.keyword} · {pr.location.split(",")[0]} · {new Date(pr.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <StatusBadge status={pr.status} />
                        <Button variant="outline" size="sm" onClick={() => setReviewingPR(pr)}>
                          {pr.status === "pending_user_approval" ? "Review" : "View"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Pack purchase modal */}
      {showPackModal && (
        <PressReleasePackModal
          onClose={() => setShowPackModal(false)}
          onPurchase={handlePackPurchase}
        />
      )}

      {/* Error toast */}
      {purchaseError && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-destructive text-destructive-foreground text-sm px-4 py-2 rounded-lg shadow-lg">
          {purchaseError}
        </div>
      )}

      {/* Form modal */}
      {showFormModal && selectedPage && (
        <PressReleaseFormModal
          defaultPageUrl={selectedBusiness?.website ?? ""}
          pageTitle={selectedPage.page_title ?? selectedPage.keyword}
          onSubmit={handleGenerate}
          onClose={() => setShowFormModal(false)}
        />
      )}
    </>
  );
}
