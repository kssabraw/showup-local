import { useState } from "react";
import { FileText, Loader2, Trash2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useSavedPages, useInvalidateSavedPages } from "@/hooks/useSavedPages";
import type { SavedPage } from "@/hooks/useSavedPages";

interface BusinessLookup {
  id: string;
  business_name: string;
}

interface Props {
  businesses: BusinessLookup[];
  onOpen: (page: SavedPage) => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function downloadPage(page: SavedPage) {
  const slug = page.keyword.replace(/\s+/g, "-").toLowerCase();
  const blob = new Blob([page.content_html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function SavedPagesList({ businesses, onOpen }: Props) {
  const [currentPage, setCurrentPage] = useState(0);
  const { data, isLoading } = useSavedPages(currentPage);
  const invalidate = useInvalidateSavedPages();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const pages = data?.pages ?? [];
  const hasMore = data?.hasMore ?? false;

  const handleDelete = async (id: string) => {
    setConfirmDeleteId(null);
    setDeletingId(id);
    await supabase.from("generated_pages").delete().eq("id", id);
    setDeletingId(null);
    invalidate();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
          <FileText className="w-4 h-4 text-muted-foreground" /> Saved Pages
        </h2>
        {pages.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {pages.length}{hasMore ? "+" : ""} page{pages.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading saved pages…
        </div>
      )}

      {!isLoading && pages.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No saved pages yet. Generate a page and click Save to store it here.
        </p>
      )}

      {!isLoading && pages.length > 0 && (
        <>
          <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
            {pages.map((page) => {
              const biz = businesses.find((b) => b.id === page.business_id);
              return (
                <div key={page.id} className="bg-card px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground truncate">
                          {page.page_title || page.keyword}
                        </p>
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                            page.mode === "reoptimize"
                              ? "bg-blue-500/10 text-blue-600"
                              : "bg-green-500/10 text-green-600"
                          }`}
                        >
                          {page.mode === "reoptimize" ? "Reoptimized" : "Generated"}
                        </span>
                        {page.composite_score != null && (
                          <span
                            className={`text-[10px] font-semibold shrink-0 ${
                              page.composite_score >= 80
                                ? "text-green-600"
                                : page.composite_score >= 60
                                ? "text-amber-600"
                                : "text-red-600"
                            }`}
                          >
                            {page.composite_score}/100
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {page.keyword} · {page.location.split(",")[0]}
                        {biz && <> · {biz.business_name}</>}
                        <span className="ml-2 opacity-60">{relativeTime(page.created_at)}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7 px-3"
                        onClick={() => onOpen(page)}
                      >
                        View
                      </Button>
                      <button
                        onClick={() => downloadPage(page)}
                        className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded border border-border hover:bg-muted/40"
                        title="Download HTML"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      {confirmDeleteId === page.id ? (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">Delete?</span>
                          <button
                            onClick={() => handleDelete(page.id)}
                            className="text-destructive font-medium hover:underline"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(page.id)}
                          disabled={deletingId === page.id}
                          className="text-muted-foreground hover:text-destructive transition-colors p-1.5 rounded"
                        >
                          {deletingId === page.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            {currentPage > 0 ? (
              <button
                onClick={() => setCurrentPage((p) => p - 1)}
                className="hover:text-foreground transition-colors"
              >
                ← Newer
              </button>
            ) : (
              <span />
            )}
            {hasMore && (
              <button
                onClick={() => setCurrentPage((p) => p + 1)}
                className="hover:text-foreground transition-colors"
              >
                Older →
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
