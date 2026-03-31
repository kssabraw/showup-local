import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check, Save, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  keyword: string;
  location: string;
  mode: "generate" | "reoptimize";
  contentHtml: string;
  schemaJson: string;
  pageTitle: string;
  tokenUsage: Record<string, any>;
  businessId: string;
  businessName: string;
  onBack: () => void;
  onNewPage: () => void;
}

export default function GeneratedPageView({
  keyword, location, mode, contentHtml, schemaJson, pageTitle,
  tokenUsage, businessId, businessName, onBack, onNewPage,
}: Props) {
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [activeTab, setActiveTab] = useState<"preview" | "html" | "schema">("preview");

  const copyHtml = async () => {
    await navigator.clipboard.writeText(contentHtml);
    setCopiedHtml(true);
    setTimeout(() => setCopiedHtml(false), 2000);
  };

  const copySchema = async () => {
    await navigator.clipboard.writeText(schemaJson);
    setCopiedSchema(true);
    setTimeout(() => setCopiedSchema(false), 2000);
  };

  const savePage = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const { error } = await supabase.from("generated_pages").insert({
        business_id: businessId,
        keyword,
        location,
        mode,
        content_html: contentHtml,
        schema_json: schemaJson,
      });
      if (error) throw error;
      setSaved(true);
    } catch (e: any) {
      setSaveError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const wordCount = contentHtml
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
          ← Back
        </button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">
              {mode === "reoptimize" ? "Reoptimized Page" : "Generated Page"}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              <span className="font-medium">{keyword}</span> · {location.split(",")[0]} · ~{wordCount} words
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>${tokenUsage.cost_usd?.toFixed(5)}</div>
            <div>{tokenUsage.input_tokens}+{tokenUsage.output_tokens} tokens</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border">
        {(["preview", "html", "schema"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "schema" ? "JSON-LD Schema" : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Preview tab */}
      {activeTab === "preview" && (
        <div className="space-y-3">
          {pageTitle && (
            <div className="flex items-start gap-3 px-4 py-3 bg-muted/40 rounded-lg border border-border">
              <span className="text-xs font-mono text-muted-foreground shrink-0 mt-0.5">&lt;title&gt;</span>
              <span className="text-sm text-foreground">{pageTitle}</span>
            </div>
          )}
          <div
            className="bg-card rounded-xl border border-border p-8 prose prose-sm max-w-none
                       prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground
                       prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-p:mb-6"
            dangerouslySetInnerHTML={{ __html: contentHtml }}
          />
        </div>
      )}

      {/* HTML tab */}
      {activeTab === "html" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={copyHtml}>
              {copiedHtml ? <><Check className="w-4 h-4 mr-1" /> Copied</> : <><Copy className="w-4 h-4 mr-1" /> Copy HTML</>}
            </Button>
          </div>
          <pre className="bg-muted rounded-xl border border-border p-4 text-xs overflow-x-auto whitespace-pre-wrap font-mono text-foreground max-h-[600px] overflow-y-auto">
            {contentHtml}
          </pre>
        </div>
      )}

      {/* Schema tab */}
      {activeTab === "schema" && (
        <div className="space-y-3">
          {schemaJson ? (
            <>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={copySchema}>
                  {copiedSchema ? <><Check className="w-4 h-4 mr-1" /> Copied</> : <><Copy className="w-4 h-4 mr-1" /> Copy Schema</>}
                </Button>
              </div>
              <pre className="bg-muted rounded-xl border border-border p-4 text-xs overflow-x-auto whitespace-pre-wrap font-mono text-foreground max-h-[600px] overflow-y-auto">
                {schemaJson}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No schema was generated for this page.</p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="bg-card rounded-xl border border-border p-6 space-y-3">
        {saveError && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive">{saveError}</div>
        )}
        <div className="flex gap-3">
          <Button
            className="flex-1 bg-accent text-accent-foreground hover:opacity-90 font-semibold"
            onClick={savePage}
            disabled={saving || saved}
          >
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</>
              : saved ? <><Check className="w-4 h-4 mr-2" /> Saved</>
              : <><Save className="w-4 h-4 mr-2" /> Save Page</>}
          </Button>
          <Button variant="outline" onClick={copyHtml} className="flex-1">
            {copiedHtml ? <><Check className="w-4 h-4 mr-1" /> Copied</> : <><Copy className="w-4 h-4 mr-1" /> Copy HTML</>}
          </Button>
        </div>
        <button onClick={onNewPage} className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors text-center">
          ← Start new keyword analysis
        </button>
      </div>
    </div>
  );
}
