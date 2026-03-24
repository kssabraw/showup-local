import { useState } from "react";
import { MapPin, Sparkles, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

const contentTypes = [
  "Blog Post", "Landing Page", "Service Page", "Location Page", "FAQ Page", "Review Response"
];

const NewContentView = ({ onBack }: { onBack: () => void }) => {
  const [contentType, setContentType] = useState("");
  const [business, setBusiness] = useState("");
  const [location, setLocation] = useState("");
  const [keywords, setKeywords] = useState("");
  const [tone, setTone] = useState("professional");

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
          ← Back to Dashboard
        </button>
        <h1 className="text-2xl font-display font-bold text-foreground">Create New Content</h1>
        <p className="text-muted-foreground text-sm mt-1">Generate SEO-optimized local content in seconds.</p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        {/* Content Type */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Content Type</label>
          <div className="relative">
            <select
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              className="w-full appearance-none bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select type...</option>
              {contentTypes.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          </div>
        </div>

        {/* Business Name */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Business Name</label>
          <input
            type="text"
            value={business}
            onChange={(e) => setBusiness(e.target.value)}
            placeholder="e.g. Joe's Plumbing"
            className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Location */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Target Location</label>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Austin, TX"
              className="w-full bg-background border border-input rounded-lg pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        {/* Keywords */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Target Keywords</label>
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="e.g. emergency plumber, 24/7 plumbing service"
            className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-xs text-muted-foreground">Separate multiple keywords with commas</p>
        </div>

        {/* Tone */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Tone</label>
          <div className="flex gap-2 flex-wrap">
            {["professional", "friendly", "authoritative", "casual"].map((t) => (
              <button
                key={t}
                onClick={() => setTone(t)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors ${
                  tone === t
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Generate Button */}
        <Button className="w-full bg-accent text-accent-foreground hover:opacity-90 font-semibold py-6">
          <Sparkles className="w-4 h-4 mr-2" />
          Generate Content
        </Button>
      </div>
    </div>
  );
};

export default NewContentView;
