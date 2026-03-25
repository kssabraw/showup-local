import { useState, useEffect } from "react";
import { MapPin, Phone, Globe, Star, Building2, Loader2, ExternalLink, RefreshCw, CheckCircle2, AlertCircle, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";

interface BusinessProfile {
  id: string;
  business_name: string;
  address: string;
  phone: string | null;
  website: string | null;
  logo: string | null;
  photo: string | null;
  gbp_category: string;
  gbp_categories: string[];
  gbp_rating: number | null;
  gbp_review_count: number | null;
  google_maps_uri: string | null;
  hours: any;
  description: string | null;
  existing_pages: any[];
  detected_icp: any | null;
  differentiators: any[];
  analysis_status: string;
}

interface PageRecord {
  url: string;
  title: string;
  h1: string;
  page_type: string;
  primary_service: string | null;
  primary_city: string | null;
}

const PAGE_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  service:      { label: "Service",         color: "bg-blue-500/10 text-blue-600" },
  location:     { label: "Location",        color: "bg-green-500/10 text-green-600" },
  city_service: { label: "City + Service",  color: "bg-purple-500/10 text-purple-600" },
  other:        { label: "Other",           color: "bg-muted text-muted-foreground" },
};

const ICP_LABELS: Record<string, string> = {
  emergency_homeowner:    "Emergency Homeowner",
  general_homeowner:      "General Homeowner",
  commercial:             "Commercial / Business",
  property_manager:       "Property Manager",
  vulnerable_homeowner:   "Vulnerable / Assisted Homeowner",
  trade_contractor:       "Trade / Contractor",
  landlord:               "Landlord / Rental Owner",
};

const TABS = ["Overview", "Website Pages", "ICP & Differentiators"] as const;
type Tab = typeof TABS[number];

const LocationDetailView = ({
  businessId,
  onBack,
}: {
  businessId: string;
  onBack: () => void;
}) => {
  const [business, setBusiness] = useState<BusinessProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("Overview");
  const [rescanning, setRescanning] = useState(false);
  const [editingDifferentiators, setEditingDifferentiators] = useState(false);
  const [differentiators, setDifferentiators] = useState<any[]>([]);

  useEffect(() => {
    fetchBusiness();
  }, [businessId]);

  const fetchBusiness = async () => {
    try {
      const { data, error } = await supabase
        .from("business_profiles")
        .select("*")
        .eq("id", businessId)
        .single();
      if (error) throw error;
      setBusiness(data as any);
      setDifferentiators((data as any).differentiators || []);
    } catch (err) {
      console.error("Error fetching business:", err);
    } finally {
      setLoading(false);
    }
  };

  const runAnalysis = async (b: BusinessProfile) => {
    if (!b.website) return;
    setRescanning(true);

    // Set status to running
    await supabase
      .from("business_profiles")
      .update({ analysis_status: "running" })
      .eq("id", b.id);

    try {
      const response = await fetch(`${NLP_SERVICE_URL}/analyze-business`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          website_url: b.website,
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          gbp_categories: b.gbp_categories || [],
        }),
      });

      if (!response.ok) throw new Error(`Analysis failed: ${response.status}`);
      const result = await response.json();

      const { error } = await supabase
        .from("business_profiles")
        .update({
          existing_pages: result.existing_pages,
          detected_icp: result.detected_icp,
          differentiators: result.differentiators,
          analysis_status: result.analysis_status,
        })
        .eq("id", b.id);

      if (error) throw error;
      await fetchBusiness();
    } catch (err) {
      console.error("Analysis error:", err);
      await supabase
        .from("business_profiles")
        .update({ analysis_status: "failed" })
        .eq("id", b.id);
      await fetchBusiness();
    } finally {
      setRescanning(false);
    }
  };

  const saveDifferentiators = async () => {
    if (!business) return;
    await supabase
      .from("business_profiles")
      .update({ differentiators })
      .eq("id", business.id);
    setBusiness({ ...business, differentiators });
    setEditingDifferentiators(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (!business) {
    return (
      <div className="text-sm text-muted-foreground text-center py-20">
        Business not found.
      </div>
    );
  }

  const pages: PageRecord[] = business.existing_pages || [];
  const icp = business.detected_icp;
  const analysisStatus = business.analysis_status;

  const pageTypeCounts = pages.reduce<Record<string, number>>((acc, p) => {
    acc[p.page_type] = (acc[p.page_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <button
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors"
        >
          ← Back to Locations
        </button>
        <div className="flex items-start gap-4">
          {(business.logo || business.photo) ? (
            <img
              src={business.logo || business.photo || ""}
              alt={business.business_name}
              className="w-14 h-14 rounded-xl object-cover border border-border flex-shrink-0"
            />
          ) : (
            <div className="w-14 h-14 rounded-xl bg-muted flex items-center justify-center flex-shrink-0">
              <Building2 className="w-6 h-6 text-muted-foreground" />
            </div>
          )}
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">{business.business_name}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{business.gbp_category}</p>
            {business.gbp_rating != null && (
              <div className="flex items-center gap-1 mt-1">
                <Star className="w-3.5 h-3.5 text-warning fill-warning" />
                <span className="text-sm font-semibold text-foreground">{business.gbp_rating}</span>
                {business.gbp_review_count != null && (
                  <span className="text-xs text-muted-foreground">({business.gbp_review_count} reviews)</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted rounded-lg p-1">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
              activeTab === tab
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {activeTab === "Overview" && (
        <div className="bg-card rounded-xl border border-border p-5 space-y-4">
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-3">
              <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <span className="text-foreground">{business.address}</span>
            </div>
            {business.phone && (
              <div className="flex items-center gap-3">
                <Phone className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-foreground">{business.phone}</span>
              </div>
            )}
            {business.website && (
              <div className="flex items-center gap-3">
                <Globe className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <a
                  href={business.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline flex items-center gap-1"
                >
                  {business.website}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
            {business.google_maps_uri && (
              <div className="flex items-center gap-3">
                <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <a
                  href={business.google_maps_uri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline flex items-center gap-1"
                >
                  View on Google Maps
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
          </div>
          {business.description && (
            <p className="text-sm text-muted-foreground border-t border-border pt-4">{business.description}</p>
          )}
          {business.hours && Array.isArray(business.hours) && business.hours.length > 0 && (
            <div className="border-t border-border pt-4">
              <p className="text-xs font-medium text-foreground mb-2">Hours</p>
              <div className="space-y-1">
                {business.hours.map((h: string, i: number) => (
                  <p key={i} className="text-xs text-muted-foreground">{h}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Website Pages tab */}
      {activeTab === "Website Pages" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <p className="text-sm text-muted-foreground">
                {pages.length > 0
                  ? `${pages.length} pages discovered`
                  : analysisStatus === "pending"
                  ? "Analysis not yet run"
                  : analysisStatus === "running"
                  ? "Analyzing website..."
                  : analysisStatus === "failed"
                  ? "Analysis failed"
                  : "No pages discovered"}
              </p>
              {analysisStatus === "running" && (
                <Loader2 className="w-4 h-4 text-accent animate-spin" />
              )}
            </div>
            {business.website && (
              <button
                onClick={() => runAnalysis(business)}
                disabled={rescanning}
                className="flex items-center gap-1.5 text-xs font-medium text-accent hover:underline disabled:opacity-50"
              >
                {rescanning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {rescanning ? "Scanning..." : "Re-scan website"}
              </button>
            )}
          </div>

          {pages.length > 0 && (
            <>
              {/* Summary counts */}
              <div className="grid grid-cols-4 gap-3">
                {(["service", "location", "city_service", "other"] as const).map((type) => (
                  <div key={type} className="bg-card border border-border rounded-lg p-3 text-center">
                    <p className="text-lg font-bold text-foreground">{pageTypeCounts[type] || 0}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{PAGE_TYPE_LABELS[type].label}</p>
                  </div>
                ))}
              </div>

              {/* Page list */}
              <div className="border border-border rounded-xl overflow-hidden divide-y divide-border">
                {pages.map((p, i) => {
                  const typeInfo = PAGE_TYPE_LABELS[p.page_type] || PAGE_TYPE_LABELS.other;
                  return (
                    <div key={i} className="px-4 py-3 hover:bg-muted/30 transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">{p.title || p.url}</p>
                          {p.h1 && p.h1 !== p.title && (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{p.h1}</p>
                          )}
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-accent hover:underline flex items-center gap-0.5 mt-0.5"
                          >
                            {p.url.replace(/^https?:\/\//, '')}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </div>
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded flex-shrink-0 ${typeInfo.color}`}>
                          {typeInfo.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {pages.length === 0 && analysisStatus === "pending" && business.website && (
            <div className="bg-card border border-border rounded-xl p-10 text-center">
              <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground">Website not yet analyzed</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">
                Scan the website to discover service, location, and city+service pages.
              </p>
              <button
                onClick={() => runAnalysis(business)}
                disabled={rescanning}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {rescanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {rescanning ? "Scanning..." : "Scan Website"}
              </button>
            </div>
          )}

          {pages.length === 0 && analysisStatus === "failed" && (
            <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-6 text-center">
              <AlertCircle className="w-7 h-7 text-destructive mx-auto mb-2" />
              <p className="text-sm text-destructive font-medium">Analysis failed</p>
              <p className="text-xs text-muted-foreground mt-1">The website could not be reached or crawled. Try re-scanning.</p>
            </div>
          )}
        </div>
      )}

      {/* ICP & Differentiators tab */}
      {activeTab === "ICP & Differentiators" && (
        <div className="space-y-5">
          {/* ICP */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-foreground mb-3">Ideal Customer Profile (ICP)</h2>
            {icp ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {ICP_LABELS[icp.primary] || icp.primary}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {Math.round(icp.confidence * 100)}% confidence
                    </p>
                  </div>
                </div>
                {icp.reasoning && (
                  <p className="text-xs text-muted-foreground border-t border-border pt-3">{icp.reasoning}</p>
                )}
                {icp.all && icp.all.length > 1 && (
                  <div className="border-t border-border pt-3 space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">All detected ICPs</p>
                    {icp.all.map((item: any, i: number) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-xs text-foreground">{ICP_LABELS[item.type] || item.type}</span>
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${Math.round(item.confidence * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground w-8 text-right">
                            {Math.round(item.confidence * 100)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-sm text-muted-foreground">
                  {analysisStatus === "pending"
                    ? "Run the website scan to auto-detect ICP."
                    : "ICP could not be determined from available data."}
                </p>
              </div>
            )}
          </div>

          {/* Differentiators */}
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Differentiators</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {differentiators.length}/3 minimum required before content generation
                </p>
              </div>
              {!editingDifferentiators ? (
                <button
                  onClick={() => setEditingDifferentiators(true)}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  Edit
                </button>
              ) : (
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      setDifferentiators(business.differentiators || []);
                      setEditingDifferentiators(false);
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveDifferentiators}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Save
                  </button>
                </div>
              )}
            </div>

            {differentiators.length > 0 ? (
              <div className="space-y-3">
                {differentiators.map((d: any, i: number) => (
                  <div key={i} className="border border-border rounded-lg p-3">
                    {editingDifferentiators ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={d.claim}
                          onChange={(e) => {
                            const updated = [...differentiators];
                            updated[i] = { ...updated[i], claim: e.target.value };
                            setDifferentiators(updated);
                          }}
                          placeholder="Claim (e.g. Same-day service)"
                          className="w-full text-sm bg-background border border-input rounded px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <input
                          type="text"
                          value={d.mechanism}
                          onChange={(e) => {
                            const updated = [...differentiators];
                            updated[i] = { ...updated[i], mechanism: e.target.value };
                            setDifferentiators(updated);
                          }}
                          placeholder="Mechanism (e.g. GPS-dispatched technicians)"
                          className="w-full text-sm bg-background border border-input rounded px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <button
                          onClick={() => setDifferentiators(differentiators.filter((_, j) => j !== i))}
                          className="text-xs text-destructive hover:underline"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="text-sm font-medium text-foreground">{d.claim}</p>
                        {d.mechanism && (
                          <p className="text-xs text-muted-foreground mt-0.5">{d.mechanism}</p>
                        )}
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent-foreground mt-1.5 inline-block">
                          {d.type}
                        </span>
                      </>
                    )}
                  </div>
                ))}
                {editingDifferentiators && (
                  <button
                    onClick={() => setDifferentiators([...differentiators, { claim: '', mechanism: '', type: 'other' }])}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    + Add differentiator
                  </button>
                )}
              </div>
            ) : (
              <div className="text-center py-4 space-y-3">
                <p className="text-sm text-muted-foreground">
                  {analysisStatus === "pending"
                    ? "Run the website scan to auto-extract differentiators."
                    : "No differentiators detected. Add them manually."}
                </p>
                <button
                  onClick={() => {
                    setDifferentiators([{ claim: '', mechanism: '', type: 'other' }]);
                    setEditingDifferentiators(true);
                  }}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  + Add differentiator manually
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LocationDetailView;
