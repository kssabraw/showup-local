import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, FileText, CheckCircle, Clock, Send, RotateCcw, Download, ChevronLeft } from "lucide-react";
import { useBusinessProfiles } from "@/hooks/useBusinessProfiles";
import { useGeneratedPages } from "@/hooks/useGeneratedPages";
import {
  usePressReleases,
  usePressReleaseReports,
  useCreatePressRelease,
  useApprovePressRelease,
  useRequestChanges,
  type PressRelease,
} from "@/hooks/usePressReleases";

// ── Status helpers ─────────────────────────────────────────────────────────────

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

// ── Review sub-view ────────────────────────────────────────────────────────────

function PressReleaseReview({
  pr,
  onBack,
}: {
  pr: PressRelease;
  onBack: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);

  const approve = useApprovePressRelease();
  const requestChanges = useRequestChanges();
  const { data: reports } = usePressReleaseReports(pr.id);

  const handleApprove = async () => {
    await approve.mutateAsync(pr.id);
    onBack();
  };

  const handleRequestChanges = async () => {
    if (!feedback.trim()) return;
    await requestChanges.mutateAsync({ id: pr.id, feedback: feedback.trim() });
    setFeedback("");
    setShowFeedback(false);
    onBack();
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

      {/* Content area */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Press Release Content</h2>
          <span className="text-xs text-muted-foreground">Generation #{pr.generation_count}</span>
        </div>
        <div className="px-6 py-5">
          {pr.content_html ? (
            <div
              className="prose prose-sm max-w-none text-foreground"
              dangerouslySetInnerHTML={{ __html: pr.content_html }}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="text-sm">Press release is being generated…</p>
              <p className="text-xs opacity-60">This usually takes 30–60 seconds</p>
            </div>
          )}
        </div>
      </div>

      {/* Previous feedback */}
      {pr.user_feedback && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-5 py-4">
          <p className="text-xs font-semibold text-amber-600 mb-1">Your previous feedback</p>
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
                  <p className="text-xs text-muted-foreground">
                    {new Date(report.uploaded_at).toLocaleDateString()}
                  </p>
                </div>
                <a
                  href={report.pdf_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs font-medium text-accent hover:opacity-80 transition-opacity"
                >
                  <Download className="w-3.5 h-3.5" /> Download
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions — only when awaiting approval and content is ready */}
      {pr.status === "pending_user_approval" && pr.content_html && (
        <div className="bg-card border border-border rounded-xl p-6 space-y-3">
          <p className="text-sm text-muted-foreground">
            Review the press release above. If it looks good, approve it and we'll syndicate it across news outlets. If you'd like changes, tell us what to improve.
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
              <Button
                variant="outline"
                className="flex-1 font-semibold py-5"
                onClick={() => setShowFeedback(true)}
              >
                <RotateCcw className="w-4 h-4 mr-2" /> Request Changes
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <textarea
                className="w-full bg-background border border-border rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
                rows={4}
                placeholder="Describe what you'd like changed — e.g. 'Focus more on our emergency response time' or 'Remove the pricing mention in paragraph 2'"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
              <div className="flex gap-3">
                <Button
                  className="flex-1 bg-accent text-accent-foreground hover:opacity-90 font-semibold py-5"
                  onClick={handleRequestChanges}
                  disabled={!feedback.trim() || requestChanges.isPending}
                >
                  {requestChanges.isPending
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…</>
                    : "Submit Feedback"}
                </Button>
                <Button
                  variant="outline"
                  className="font-semibold py-5"
                  onClick={() => { setShowFeedback(false); setFeedback(""); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function PressReleasesView() {
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [reviewingPR, setReviewingPR] = useState<PressRelease | null>(null);
  const [generating, setGenerating] = useState(false);

  const { data: businesses = [], isLoading: businessesLoading } = useBusinessProfiles();
  const { data: pages = [], isLoading: pagesLoading } = useGeneratedPages(selectedBusinessId);
  const { data: pressReleases = [], isLoading: prsLoading } = usePressReleases(selectedBusinessId);
  const createPR = useCreatePressRelease();

  const selectedBusiness = businesses.find((b) => b.id === selectedBusinessId);
  const selectedPage = pages.find((p) => p.id === selectedPageId);

  // Auto-select if only one business
  if (!selectedBusinessId && businesses.length === 1) {
    setSelectedBusinessId(businesses[0].id);
  }

  const handleGenerate = async () => {
    if (!selectedPageId || !selectedBusinessId || !selectedPage) return;
    setGenerating(true);
    try {
      const pr = await createPR.mutateAsync({
        business_id: selectedBusinessId,
        generated_page_id: selectedPageId,
        keyword: selectedPage.keyword,
        location: selectedPage.location,
        page_title: selectedPage.page_title ?? selectedPage.keyword,
      });
      setSelectedPageId(null);
      setReviewingPR(pr);
    } finally {
      setGenerating(false);
    }
  };

  if (reviewingPR) {
    // Sync with latest data from hook
    const latest = pressReleases.find((pr) => pr.id === reviewingPR.id) ?? reviewingPR;
    return (
      <PressReleaseReview
        pr={latest}
        onBack={() => setReviewingPR(null)}
      />
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Press Releases</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Generate a press release from any page and we'll syndicate it across news outlets.
        </p>
      </div>

      {/* Business selector */}
      {businesses.length > 1 && (
        <div className="bg-card border border-border rounded-xl px-5 py-4">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-2">
            Business
          </label>
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
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      )}

      {selectedBusinessId && (
        <>
          {/* Generate new press release */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Generate New Press Release</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Select a page to generate a press release for</p>
            </div>

            {pagesLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading pages…</span>
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
                  <label
                    key={page.id}
                    className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      className="accent-accent w-4 h-4 shrink-0"
                      checked={selectedPageId === page.id}
                      onChange={() => setSelectedPageId(selectedPageId === page.id ? null : page.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {page.page_title || page.keyword}
                      </p>
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
                  onClick={handleGenerate}
                  disabled={generating}
                >
                  {generating
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating Press Release…</>
                    : <><Send className="w-4 h-4 mr-2" /> Generate Press Release</>}
                </Button>
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Press release syndication is a paid add-on — pricing shown at confirmation.
                </p>
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
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Loading…</span>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {pressReleases.map((pr) => (
                    <div key={pr.id} className="px-6 py-4 flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {pr.page_title || pr.keyword}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {pr.keyword} · {pr.location.split(",")[0]} · {new Date(pr.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <StatusBadge status={pr.status} />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setReviewingPR(pr)}
                      >
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
  );
}
