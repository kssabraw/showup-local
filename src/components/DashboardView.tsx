import { FileText, MapPin, TrendingUp, Plus, ArrowRight } from "lucide-react";
import { useDashboardStats } from "@/hooks/useDashboardStats";

interface Props {
  onNavigate: (item: string) => void;
}

const DashboardView = ({ onNavigate }: Props) => {
  const { data: stats, isLoading: loading } = useDashboardStats();

  const isEmpty = !loading && stats?.locations === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Your local SEO content at a glance.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <>
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-card rounded-xl border border-border p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="h-3 w-24 bg-muted rounded animate-pulse" />
                  <div className="h-4 w-4 bg-muted rounded animate-pulse" />
                </div>
                <div className="h-7 w-12 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </>
        ) : (
          <>
            <button
              onClick={() => onNavigate("saved-pages")}
              className="bg-card rounded-xl border border-border p-5 hover:shadow-md transition-shadow text-left w-full"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Content</span>
                <FileText className="w-4 h-4 text-accent" />
              </div>
              <p className={`text-2xl font-display font-bold ${stats?.totalContent === 0 ? "text-muted-foreground" : "text-foreground"}`}>
                {stats?.totalContent ?? 0}
              </p>
            </button>

            <div className="bg-card rounded-xl border border-border p-5 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Locations</span>
                <MapPin className="w-4 h-4 text-accent" />
              </div>
              <p className={`text-2xl font-display font-bold ${stats?.locations === 0 ? "text-muted-foreground" : "text-foreground"}`}>
                {stats?.locations ?? 0}
              </p>
            </div>

            <div className="bg-card rounded-xl border border-border p-5 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Avg. SEO Score</span>
                <TrendingUp className="w-4 h-4 text-accent" />
              </div>
              {stats?.avgScore != null ? (
                <div className="flex items-end gap-2">
                  <p className={`text-2xl font-display font-bold ${
                    stats.avgScore >= 80 ? "text-green-500" :
                    stats.avgScore >= 60 ? "text-amber-500" :
                    "text-red-500"
                  }`}>
                    {stats.avgScore}
                  </p>
                  <p className="text-sm text-muted-foreground mb-0.5">/ 100</p>
                </div>
              ) : (
                <div>
                  <p className="text-2xl font-display font-bold text-muted-foreground">—</p>
                  <p className="text-xs text-muted-foreground mt-1">Score pages to see your average</p>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Empty state */}
      {isEmpty && (
        <div className="bg-card border border-dashed border-border rounded-xl p-10 flex flex-col items-center text-center gap-4">
          <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
            <MapPin className="w-6 h-6 text-accent" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">Add your first business</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Connect a Google Business Profile to start generating optimised local SEO pages.
            </p>
          </div>
          <button
            onClick={() => onNavigate("new")}
            className="inline-flex items-center gap-2 bg-accent text-accent-foreground text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            Add Business
          </button>
        </div>
      )}

      {/* Quick actions — only when there's data */}
      {!loading && !isEmpty && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => onNavigate("content")}
            className="group flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:shadow-md transition-shadow text-left"
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-foreground">Generate a page</p>
              <p className="text-xs text-muted-foreground">Create a new local SEO page for a keyword</p>
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0 ml-3" />
          </button>

          <button
            onClick={() => onNavigate("planning")}
            className="group flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:shadow-md transition-shadow text-left"
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-foreground">Plan your content</p>
              <p className="text-xs text-muted-foreground">Discover missing pages across your site</p>
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0 ml-3" />
          </button>
        </div>
      )}
    </div>
  );
};

export default DashboardView;
