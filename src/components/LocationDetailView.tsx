import { useState, useEffect } from "react";
import { MapPin, Phone, Globe, Star, Building2, Loader2, ExternalLink, RefreshCw, CheckCircle2, AlertCircle, Sparkles, Plus, Trash2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const NLP_SERVICE_URL = import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";

interface BusinessProfile {
  id: string;
  gbp_place_id: string;
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
  brand_voice: any | null;
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


const TABS = ["Overview", "Website Pages", "ICP & Differentiators", "Brand Voice"] as const;
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
  const [refreshingGBP, setRefreshingGBP] = useState(false);
  const [gbpRefreshStatus, setGbpRefreshStatus] = useState<"idle" | "success" | "error">("idle");
  const [editingDifferentiators, setEditingDifferentiators] = useState(false);
  const [differentiators, setDifferentiators] = useState<any[]>([]);
  const [editingIcp, setEditingIcp] = useState(false);
  const [icpSegments, setIcpSegments] = useState<any[]>([]);
  const [icpReasoning, setIcpReasoning] = useState("");
  const [savingIcp, setSavingIcp] = useState(false);
  const [scanningBrandVoice, setScanningBrandVoice] = useState(false);
  const [editingBrandVoice, setEditingBrandVoice] = useState(false);
  const [brandVoiceDraft, setBrandVoiceDraft] = useState<any>(null);
  const [savingBrandVoice, setSavingBrandVoice] = useState(false);

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

  const refreshFromGBP = async () => {
    if (!business) return;
    setRefreshingGBP(true);
    setGbpRefreshStatus("idle");
    try {
      const { data, error } = await supabase.functions.invoke("google-places", {
        body: { action: "details", place_id: business.gbp_place_id },
      });
      if (error) throw new Error(error.message || "Edge function error");
      if (!data?.details) throw new Error(data?.error || "No details returned from GBP");
      const d = data.details;
      const updates = {
        business_name: d.name || business.business_name,
        description: d.description || business.description,
        address: d.address || business.address,
        phone: d.phone || business.phone,
        website: d.website || business.website,
        logo: d.logo || business.logo,
        photo: d.photo || business.photo,
        gbp_category: d.category || business.gbp_category,
        gbp_categories: d.categories ?? business.gbp_categories,
        gbp_rating: d.rating ?? business.gbp_rating,
        gbp_review_count: d.review_count ?? business.gbp_review_count,
        google_maps_uri: d.google_maps_uri || business.google_maps_uri,
        hours: d.hours ?? business.hours,
      };
      await supabase.from("business_profiles").update(updates).eq("id", business.id);
      await fetchBusiness();
      setGbpRefreshStatus("success");
      setTimeout(() => setGbpRefreshStatus("idle"), 3000);
    } catch (err) {
      console.error("GBP refresh error:", err);
      setGbpRefreshStatus("error");
      setTimeout(() => setGbpRefreshStatus("idle"), 5000);
    } finally {
      setRefreshingGBP(false);
    }
  };

  const fetchWebsiteFromGBP = async (b: BusinessProfile): Promise<string | null> => {
    try {
      const { data, error } = await supabase.functions.invoke("google-places", {
        body: { action: "details", place_id: b.gbp_place_id },
      });
      if (error || !data?.details?.website) return null;
      const website = data.details.website;
      await supabase.from("business_profiles").update({ website }).eq("id", b.id);
      setBusiness((prev) => prev ? { ...prev, website } : prev);
      return website;
    } catch {
      return null;
    }
  };

  const runAnalysis = async (b: BusinessProfile) => {
    setRescanning(true);

    let website = b.website;
    if (!website) {
      website = await fetchWebsiteFromGBP(b);
    }
    if (!website) {
      setRescanning(false);
      return;
    }

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
          website_url: website,
          business_name: b.business_name,
          gbp_category: b.gbp_category,
          gbp_categories: b.gbp_categories || [],
        }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(`Analysis failed: ${response.status} — ${errBody.detail || JSON.stringify(errBody)}`);
      }
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

  const blankSegment = () => ({
    label: "",
    confidence: 0.8,
    primary: false,
    demographics: { description: "", situation: "" },
    psychographics: { trigger: "", fears: [""], motivations: [""], buying_behavior: "" },
    messaging: { tone: "", hooks: [""], trust_signals: [""] },
  });

  const startEditingIcp = (icp: any) => {
    setIcpSegments(JSON.parse(JSON.stringify(icp?.segments || [])));
    setIcpReasoning(icp?.reasoning || "");
    setEditingIcp(true);
  };

  const saveIcp = async () => {
    if (!business) return;
    setSavingIcp(true);
    const updated = { ...business.detected_icp, segments: icpSegments, reasoning: icpReasoning };
    await supabase.from("business_profiles").update({ detected_icp: updated }).eq("id", business.id);
    await fetchBusiness();
    setEditingIcp(false);
    setSavingIcp(false);
  };

  const updateSeg = (i: number, path: string[], value: any) => {
    setIcpSegments(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next[i];
      for (let k = 0; k < path.length - 1; k++) obj = obj[path[k]];
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const updateListItem = (segIdx: number, section: string, field: string, itemIdx: number, value: string) => {
    setIcpSegments(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      next[segIdx][section][field][itemIdx] = value;
      return next;
    });
  };

  const addListItem = (segIdx: number, section: string, field: string) => {
    setIcpSegments(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      next[segIdx][section][field] = [...(next[segIdx][section][field] || []), ""];
      return next;
    });
  };

  const removeListItem = (segIdx: number, section: string, field: string, itemIdx: number) => {
    setIcpSegments(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      next[segIdx][section][field].splice(itemIdx, 1);
      return next;
    });
  };

  const scanBrandVoice = async (b: BusinessProfile) => {
    let website = b.website;
    if (!website) {
      website = await fetchWebsiteFromGBP(b);
      if (!website) return;
    }
    setScanningBrandVoice(true);
    try {
      const response = await fetch(`${NLP_SERVICE_URL}/analyze-brand-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          website_url: website,
          business_name: b.business_name,
          existing_pages: b.existing_pages || [],
        }),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(`Brand voice scan failed: ${response.status} — ${errBody.detail || JSON.stringify(errBody)}`);
      }
      const result = await response.json();
      const { error } = await supabase
        .from("business_profiles")
        .update({ brand_voice: result.brand_voice })
        .eq("id", b.id);
      if (error) throw error;
      await fetchBusiness();
    } catch (err) {
      console.error("Brand voice scan error:", err);
    } finally {
      setScanningBrandVoice(false);
    }
  };

  const saveBrandVoice = async () => {
    if (!business) return;
    setSavingBrandVoice(true);
    await supabase.from("business_profiles").update({ brand_voice: brandVoiceDraft }).eq("id", business.id);
    await fetchBusiness();
    setEditingBrandVoice(false);
    setSavingBrandVoice(false);
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
          <div className="border-t border-border pt-4 flex items-center justify-end gap-3">
            {gbpRefreshStatus === "success" && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Updated successfully
              </span>
            )}
            {gbpRefreshStatus === "error" && (
              <span className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> Update failed — check console
              </span>
            )}
            <button
              onClick={refreshFromGBP}
              disabled={refreshingGBP}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-background text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              {refreshingGBP
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <RefreshCw className="w-4 h-4" />}
              {refreshingGBP ? "Updating..." : "Update"}
            </button>
          </div>
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
                  : analysisStatus === "running"
                  ? "Analyzing website..."
                  : analysisStatus === "failed"
                  ? "Analysis failed"
                  : "Analysis not yet run"}
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

          {pages.length === 0 && analysisStatus !== "running" && (
            <div className="bg-card border border-border rounded-xl p-10 text-center">
              {analysisStatus === "failed" ? (
                <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
              ) : (
                <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              )}
              <p className="text-sm font-medium text-foreground">
                {analysisStatus === "failed" ? "Analysis failed" : "Website not yet analyzed"}
              </p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">
                {analysisStatus === "failed"
                  ? "The website could not be reached or crawled."
                  : "Scan the website to discover service, location, and city+service pages."}
              </p>
              <button
                onClick={() => runAnalysis(business)}
                disabled={rescanning}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {rescanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {rescanning ? "Scanning..." : analysisStatus === "failed" ? "Retry Scan" : "Scan Website"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ICP & Differentiators tab */}
      {activeTab === "ICP & Differentiators" && (
        <div className="space-y-5">
          {/* ICP */}
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">Ideal Customer Profile (ICP)</h2>
              <div className="flex items-center gap-3">
                {icp && !editingIcp && (
                  <button
                    onClick={() => startEditingIcp(icp)}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Edit
                  </button>
                )}
                {analysisStatus !== "running" && !editingIcp && (
                  <button
                    onClick={() => runAnalysis(business)}
                    disabled={rescanning}
                    className="flex items-center gap-1.5 text-xs font-medium text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {rescanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    {rescanning ? "Scanning..." : icp ? "Re-run" : "Scan Website"}
                  </button>
                )}
                {editingIcp && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setEditingIcp(false)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveIcp}
                      disabled={savingIcp}
                      className="text-xs font-medium text-accent hover:underline disabled:opacity-40"
                    >
                      {savingIcp ? "Saving..." : "Save"}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* View mode */}
            {!editingIcp && icp && (
              <div className="space-y-4">
                {icp.reasoning && (
                  <p className="text-xs text-muted-foreground">{icp.reasoning}</p>
                )}
                {(icp.segments || []).map((seg: any, i: number) => (
                  <div key={i} className="border border-border rounded-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {seg.primary && <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />}
                        <span className="text-sm font-semibold text-foreground">{seg.label}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{Math.round((seg.confidence || 0) * 100)}% confidence</span>
                    </div>
                    {seg.demographics && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Who They Are</p>
                        <p className="text-xs text-foreground">{seg.demographics.description}</p>
                        <p className="text-xs text-muted-foreground">{seg.demographics.situation}</p>
                      </div>
                    )}
                    {seg.psychographics && (
                      <div className="space-y-2 border-t border-border pt-3">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Psychographics</p>
                        {seg.psychographics.trigger && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Trigger: </span>{seg.psychographics.trigger}</p>}
                        {seg.psychographics.fears?.length > 0 && (
                          <div><p className="text-xs font-medium text-foreground mb-1">Fears</p>
                            <ul className="space-y-0.5">{seg.psychographics.fears.map((f: string, j: number) => <li key={j} className="text-xs text-muted-foreground flex gap-1.5"><span>•</span>{f}</li>)}</ul>
                          </div>
                        )}
                        {seg.psychographics.motivations?.length > 0 && (
                          <div><p className="text-xs font-medium text-foreground mb-1">Motivations</p>
                            <ul className="space-y-0.5">{seg.psychographics.motivations.map((m: string, j: number) => <li key={j} className="text-xs text-muted-foreground flex gap-1.5"><span>•</span>{m}</li>)}</ul>
                          </div>
                        )}
                        {seg.psychographics.buying_behavior && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Buying Behavior: </span>{seg.psychographics.buying_behavior}</p>}
                      </div>
                    )}
                    {seg.messaging && (
                      <div className="space-y-2 border-t border-border pt-3">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Messaging</p>
                        {seg.messaging.tone && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Tone: </span>{seg.messaging.tone}</p>}
                        {seg.messaging.hooks?.length > 0 && (
                          <div><p className="text-xs font-medium text-foreground mb-1">Hooks</p>
                            <ul className="space-y-0.5">{seg.messaging.hooks.map((h: string, j: number) => <li key={j} className="text-xs text-muted-foreground flex gap-1.5"><span>•</span>{h}</li>)}</ul>
                          </div>
                        )}
                        {seg.messaging.trust_signals?.length > 0 && (
                          <div><p className="text-xs font-medium text-foreground mb-1">Trust Signals</p>
                            <ul className="space-y-0.5">{seg.messaging.trust_signals.map((t: string, j: number) => <li key={j} className="text-xs text-muted-foreground flex gap-1.5"><span>•</span>{t}</li>)}</ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Edit mode */}
            {editingIcp && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide block mb-1">Reasoning</label>
                  <textarea
                    value={icpReasoning}
                    onChange={e => setIcpReasoning(e.target.value)}
                    rows={2}
                    className="w-full text-xs rounded-md border border-border bg-background px-3 py-2 text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                {icpSegments.map((seg, i) => (
                  <div key={i} className="border border-border rounded-lg p-4 space-y-4">
                    {/* Segment header */}
                    <div className="flex items-center justify-between gap-2">
                      <input
                        value={seg.label}
                        onChange={e => updateSeg(i, ["label"], e.target.value)}
                        placeholder="Segment name"
                        className="flex-1 text-sm font-semibold rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                        <input type="checkbox" checked={seg.primary} onChange={e => updateSeg(i, ["primary"], e.target.checked)} className="accent-accent" />
                        Primary
                      </label>
                      <button onClick={() => setIcpSegments(prev => prev.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Demographics */}
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Who They Are</p>
                      <input value={seg.demographics?.description || ""} onChange={e => updateSeg(i, ["demographics", "description"], e.target.value)} placeholder="Demographics description" className="w-full text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                      <input value={seg.demographics?.situation || ""} onChange={e => updateSeg(i, ["demographics", "situation"], e.target.value)} placeholder="Situation" className="w-full text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                    </div>

                    {/* Psychographics */}
                    <div className="space-y-2 border-t border-border pt-3">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Psychographics</p>
                      <input value={seg.psychographics?.trigger || ""} onChange={e => updateSeg(i, ["psychographics", "trigger"], e.target.value)} placeholder="Trigger (moment that causes them to search)" className="w-full text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                      {(["fears", "motivations"] as const).map(field => (
                        <div key={field}>
                          <p className="text-xs font-medium text-foreground mb-1 capitalize">{field}</p>
                          {(seg.psychographics?.[field] || []).map((val: string, j: number) => (
                            <div key={j} className="flex gap-1.5 mb-1">
                              <input value={val} onChange={e => updateListItem(i, "psychographics", field, j, e.target.value)} placeholder={`${field.slice(0, -1)}...`} className="flex-1 text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                              <button onClick={() => removeListItem(i, "psychographics", field, j)} className="text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          ))}
                          <button onClick={() => addListItem(i, "psychographics", field)} className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" />Add {field.slice(0, -1)}</button>
                        </div>
                      ))}
                      <input value={seg.psychographics?.buying_behavior || ""} onChange={e => updateSeg(i, ["psychographics", "buying_behavior"], e.target.value)} placeholder="Buying behavior" className="w-full text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                    </div>

                    {/* Messaging */}
                    <div className="space-y-2 border-t border-border pt-3">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Messaging</p>
                      <input value={seg.messaging?.tone || ""} onChange={e => updateSeg(i, ["messaging", "tone"], e.target.value)} placeholder="Tone" className="w-full text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                      {(["hooks", "trust_signals"] as const).map(field => (
                        <div key={field}>
                          <p className="text-xs font-medium text-foreground mb-1">{field === "hooks" ? "Hooks" : "Trust Signals"}</p>
                          {(seg.messaging?.[field] || []).map((val: string, j: number) => (
                            <div key={j} className="flex gap-1.5 mb-1">
                              <input value={val} onChange={e => updateListItem(i, "messaging", field, j, e.target.value)} placeholder={field === "hooks" ? "Hook..." : "Trust signal..."} className="flex-1 text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                              <button onClick={() => removeListItem(i, "messaging", field, j)} className="text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          ))}
                          <button onClick={() => addListItem(i, "messaging", field)} className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" />Add {field === "hooks" ? "hook" : "trust signal"}</button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => setIcpSegments(prev => [...prev, blankSegment()])}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-xs text-muted-foreground hover:text-foreground hover:border-accent transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Segment
                </button>
              </div>
            )}

            {/* Empty state */}
            {!editingIcp && !icp && (
              <p className="text-sm text-muted-foreground text-center py-4">
                {analysisStatus === "running" ? "Detecting ICP…" : "Click Scan Website above to auto-detect ICP."}
              </p>
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

      {/* Brand Voice tab */}
      {activeTab === "Brand Voice" && (
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Brand Voice</h2>
            <div className="flex items-center gap-3">
              {business.brand_voice && !editingBrandVoice && (
                <button
                  onClick={() => { setBrandVoiceDraft(JSON.parse(JSON.stringify(business.brand_voice))); setEditingBrandVoice(true); }}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  Edit
                </button>
              )}
              {!editingBrandVoice && (
                <button
                  onClick={() => scanBrandVoice(business)}
                  disabled={scanningBrandVoice}
                  className="flex items-center gap-1.5 text-xs font-medium text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {scanningBrandVoice ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {scanningBrandVoice ? "Scanning..." : business.brand_voice ? "Re-scan" : "Scan Website"}
                </button>
              )}
              {editingBrandVoice && (
                <div className="flex items-center gap-3">
                  <button onClick={() => setEditingBrandVoice(false)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                  <button onClick={saveBrandVoice} disabled={savingBrandVoice} className="text-xs font-medium text-accent hover:underline disabled:opacity-40">
                    {savingBrandVoice ? "Saving..." : "Save"}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Empty state */}
          {!business.brand_voice && !editingBrandVoice && (
            <p className="text-sm text-muted-foreground text-center py-4">
              {scanningBrandVoice ? "Scanning website for brand voice signals…" : "Click Scan Website to auto-generate a brand voice profile."}
            </p>
          )}

          {/* View mode */}
          {business.brand_voice && !editingBrandVoice && (() => {
            const bv = business.brand_voice;
            return (
              <div className="space-y-5">
                {/* Personality + Tone */}
                {bv.personality?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Personality</p>
                    <div className="flex flex-wrap gap-1.5">
                      {bv.personality.map((t: string, i: number) => (
                        <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-accent/10 text-accent-foreground font-medium">{t}</span>
                      ))}
                    </div>
                  </div>
                )}
                {bv.tone && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Tone</p>
                    <p className="text-xs text-foreground">{bv.tone}</p>
                  </div>
                )}
                {/* Writing Style */}
                {bv.writing_style && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Writing Style</p>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(bv.writing_style).map(([k, v]: [string, any]) => (
                        <div key={k} className="bg-muted/40 rounded-lg px-3 py-2">
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{k.replace(/_/g, ' ')}</p>
                          <p className="text-xs text-foreground mt-0.5">{v}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Vocabulary */}
                {bv.vocabulary && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Vocabulary</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs font-medium text-green-600 mb-1">Use</p>
                        <ul className="space-y-0.5">{(bv.vocabulary.use || []).map((w: string, i: number) => <li key={i} className="text-xs text-foreground flex gap-1.5"><span className="text-green-500">+</span>{w}</li>)}</ul>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-destructive mb-1">Avoid</p>
                        <ul className="space-y-0.5">{(bv.vocabulary.avoid || []).map((w: string, i: number) => <li key={i} className="text-xs text-foreground flex gap-1.5"><span className="text-destructive">−</span>{w}</li>)}</ul>
                      </div>
                    </div>
                  </div>
                )}
                {/* Messaging Themes */}
                {bv.messaging_themes?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Messaging Themes</p>
                    <ul className="space-y-0.5">{bv.messaging_themes.map((t: string, i: number) => <li key={i} className="text-xs text-muted-foreground flex gap-1.5"><span>•</span>{t}</li>)}</ul>
                  </div>
                )}
                {/* Sample Phrases */}
                {bv.sample_phrases?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Sample Phrases</p>
                    <ul className="space-y-1">{bv.sample_phrases.map((p: string, i: number) => <li key={i} className="text-xs text-foreground italic border-l-2 border-accent pl-3">"{p}"</li>)}</ul>
                  </div>
                )}
                {/* Content Generation Instructions */}
                {bv.content_generation_instructions && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Content Generation Instructions</p>
                    <p className="text-xs text-foreground">{bv.content_generation_instructions}</p>
                  </div>
                )}
                {/* Writer Execution Guide */}
                {bv.writer_execution_guide && (
                  <div className="border-t border-border pt-4 space-y-4">
                    <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Writer Execution Guide</p>
                    {Object.entries(bv.writer_execution_guide).map(([key, val]: [string, any]) => (
                      <div key={key}>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{key.replace(/_/g, ' ')}</p>
                        {typeof val === 'string' && <p className="text-xs text-foreground">{val}</p>}
                        {Array.isArray(val) && (
                          <ul className="space-y-0.5">{val.map((item: any, i: number) => (
                            <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                              <span>•</span>
                              {typeof item === 'string' ? item : JSON.stringify(item)}
                            </li>
                          ))}</ul>
                        )}
                        {typeof val === 'object' && !Array.isArray(val) && val !== null && (
                          <div className="space-y-1">
                            {Object.entries(val).map(([k2, v2]: [string, any]) => (
                              <div key={k2}>
                                <span className="text-xs font-medium text-foreground capitalize">{k2.replace(/_/g, ' ')}: </span>
                                <span className="text-xs text-muted-foreground">{Array.isArray(v2) ? v2.join(', ') : String(v2)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Edit mode */}
          {editingBrandVoice && brandVoiceDraft && (
            <div className="space-y-5">
              {/* Personality */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Personality Traits</p>
                {(brandVoiceDraft.personality || []).map((t: string, i: number) => (
                  <div key={i} className="flex gap-1.5 mb-1">
                    <input value={t} onChange={e => { const d = {...brandVoiceDraft, personality: [...brandVoiceDraft.personality]}; d.personality[i] = e.target.value; setBrandVoiceDraft(d); }} className="flex-1 text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                    <button onClick={() => setBrandVoiceDraft({...brandVoiceDraft, personality: brandVoiceDraft.personality.filter((_: any, j: number) => j !== i)})} className="text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => setBrandVoiceDraft({...brandVoiceDraft, personality: [...(brandVoiceDraft.personality || []), ""]})} className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" />Add trait</button>
              </div>
              {/* Tone */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Tone</p>
                <textarea value={brandVoiceDraft.tone || ""} onChange={e => setBrandVoiceDraft({...brandVoiceDraft, tone: e.target.value})} rows={2} className="w-full text-xs rounded-md border border-border bg-background px-3 py-2 text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              {/* Writing Style */}
              {brandVoiceDraft.writing_style && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Writing Style</p>
                  {Object.keys(brandVoiceDraft.writing_style).map(k => (
                    <div key={k} className="mb-2">
                      <p className="text-xs text-muted-foreground capitalize mb-0.5">{k.replace(/_/g, ' ')}</p>
                      <input value={brandVoiceDraft.writing_style[k] || ""} onChange={e => setBrandVoiceDraft({...brandVoiceDraft, writing_style: {...brandVoiceDraft.writing_style, [k]: e.target.value}})} className="w-full text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                    </div>
                  ))}
                </div>
              )}
              {/* Vocabulary */}
              {brandVoiceDraft.vocabulary && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Vocabulary</p>
                  {(['use', 'avoid'] as const).map(field => (
                    <div key={field} className="mb-3">
                      <p className={`text-xs font-medium mb-1 ${field === 'use' ? 'text-green-600' : 'text-destructive'}`}>{field === 'use' ? 'Use' : 'Avoid'}</p>
                      {(brandVoiceDraft.vocabulary[field] || []).map((w: string, i: number) => (
                        <div key={i} className="flex gap-1.5 mb-1">
                          <input value={w} onChange={e => { const v = [...brandVoiceDraft.vocabulary[field]]; v[i] = e.target.value; setBrandVoiceDraft({...brandVoiceDraft, vocabulary: {...brandVoiceDraft.vocabulary, [field]: v}}); }} className="flex-1 text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                          <button onClick={() => { const v = brandVoiceDraft.vocabulary[field].filter((_: any, j: number) => j !== i); setBrandVoiceDraft({...brandVoiceDraft, vocabulary: {...brandVoiceDraft.vocabulary, [field]: v}}); }} className="text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                      <button onClick={() => setBrandVoiceDraft({...brandVoiceDraft, vocabulary: {...brandVoiceDraft.vocabulary, [field]: [...(brandVoiceDraft.vocabulary[field] || []), ""]}})} className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" />Add word</button>
                    </div>
                  ))}
                </div>
              )}
              {/* Messaging Themes */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Messaging Themes</p>
                {(brandVoiceDraft.messaging_themes || []).map((t: string, i: number) => (
                  <div key={i} className="flex gap-1.5 mb-1">
                    <input value={t} onChange={e => { const d = [...brandVoiceDraft.messaging_themes]; d[i] = e.target.value; setBrandVoiceDraft({...brandVoiceDraft, messaging_themes: d}); }} className="flex-1 text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                    <button onClick={() => setBrandVoiceDraft({...brandVoiceDraft, messaging_themes: brandVoiceDraft.messaging_themes.filter((_: any, j: number) => j !== i)})} className="text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => setBrandVoiceDraft({...brandVoiceDraft, messaging_themes: [...(brandVoiceDraft.messaging_themes || []), ""]})} className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" />Add theme</button>
              </div>
              {/* Sample Phrases */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Sample Phrases</p>
                {(brandVoiceDraft.sample_phrases || []).map((p: string, i: number) => (
                  <div key={i} className="flex gap-1.5 mb-1">
                    <input value={p} onChange={e => { const d = [...brandVoiceDraft.sample_phrases]; d[i] = e.target.value; setBrandVoiceDraft({...brandVoiceDraft, sample_phrases: d}); }} className="flex-1 text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-accent" />
                    <button onClick={() => setBrandVoiceDraft({...brandVoiceDraft, sample_phrases: brandVoiceDraft.sample_phrases.filter((_: any, j: number) => j !== i)})} className="text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => setBrandVoiceDraft({...brandVoiceDraft, sample_phrases: [...(brandVoiceDraft.sample_phrases || []), ""]})} className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" />Add phrase</button>
              </div>
              {/* Content Generation Instructions */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Content Generation Instructions</p>
                <textarea value={brandVoiceDraft.content_generation_instructions || ""} onChange={e => setBrandVoiceDraft({...brandVoiceDraft, content_generation_instructions: e.target.value})} rows={3} className="w-full text-xs rounded-md border border-border bg-background px-3 py-2 text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LocationDetailView;
