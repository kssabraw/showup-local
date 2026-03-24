import { FileText, MapPin, TrendingUp, Eye, Clock } from "lucide-react";

const stats = [
  { label: "Total Content", value: "24", icon: FileText, change: "+3 this week" },
  { label: "Locations", value: "8", icon: MapPin, change: "2 cities" },
  { label: "Avg. SEO Score", value: "87", icon: TrendingUp, change: "+5 pts" },
  { label: "Total Views", value: "12.4k", icon: Eye, change: "+18% MoM" },
];

const recentContent = [
  { title: "Best Coffee Shops in Austin, TX", location: "Austin, TX", score: 92, status: "Published", date: "2 hours ago" },
  { title: "Top 10 Plumbers in Denver, CO", location: "Denver, CO", score: 85, status: "Draft", date: "Yesterday" },
  { title: "Family Restaurants Near Downtown Seattle", location: "Seattle, WA", score: 78, status: "Published", date: "3 days ago" },
  { title: "Emergency Vet Clinics in Portland, OR", location: "Portland, OR", score: 90, status: "Review", date: "4 days ago" },
];

const DashboardView = () => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Your local SEO content at a glance.</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="bg-card rounded-xl border border-border p-5 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stat.label}</span>
                <Icon className="w-4 h-4 text-accent" />
              </div>
              <p className="text-2xl font-display font-bold text-foreground">{stat.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{stat.change}</p>
            </div>
          );
        })}
      </div>

      {/* Recent Content */}
      <div className="bg-card rounded-xl border border-border">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-semibold text-foreground">Recent Content</h2>
          <button className="text-xs text-accent hover:underline font-medium">View all</button>
        </div>
        <div className="divide-y divide-border">
          {recentContent.map((item) => (
            <div key={item.title} className="px-5 py-4 flex items-center justify-between hover:bg-muted/50 transition-colors cursor-pointer">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                <div className="flex items-center gap-3 mt-1">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <MapPin className="w-3 h-3" /> {item.location}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" /> {item.date}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3 ml-4">
                <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                  item.status === "Published" ? "bg-success/10 text-success" :
                  item.status === "Draft" ? "bg-muted text-muted-foreground" :
                  "bg-warning/10 text-warning"
                }`}>
                  {item.status}
                </span>
                <div className="flex items-center gap-1.5">
                  <div className="w-8 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div 
                      className="h-full rounded-full bg-accent" 
                      style={{ width: `${item.score}%` }} 
                    />
                  </div>
                  <span className="text-xs font-medium text-foreground">{item.score}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DashboardView;
