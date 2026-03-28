import { FileText, MapPin, TrendingUp } from "lucide-react";

const stats = [
  { label: "Total Content", icon: FileText },
  { label: "Locations", icon: MapPin },
  { label: "Avg. SEO Score", icon: TrendingUp },
];

const DashboardView = () => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Your local SEO content at a glance.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="bg-card rounded-xl border border-border p-5 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stat.label}</span>
                <Icon className="w-4 h-4 text-accent" />
              </div>
              <p className="text-2xl font-display font-bold text-muted-foreground">—</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DashboardView;
