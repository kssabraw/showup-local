import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, X, Plus, Trash2 } from "lucide-react";

export interface PressReleaseFormValues {
  spokesperson: string;
  contact_email: string;
  page_url: string;
  additional_links: { url: string; anchor_text: string }[];
}

interface Props {
  defaultPageUrl?: string;
  pageTitle: string;
  onSubmit: (values: PressReleaseFormValues) => Promise<void>;
  onClose: () => void;
}

export default function PressReleaseFormModal({
  defaultPageUrl = "",
  pageTitle,
  onSubmit,
  onClose,
}: Props) {
  const [spokesperson, setSpokesperson] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [pageUrl, setPageUrl] = useState(defaultPageUrl);
  const [additionalLinks, setAdditionalLinks] = useState<{ url: string; anchor_text: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const canAddLink = additionalLinks.length < 2;

  const addLink = () => {
    if (!canAddLink) return;
    setAdditionalLinks([...additionalLinks, { url: "", anchor_text: "" }]);
  };

  const removeLink = (i: number) => {
    setAdditionalLinks(additionalLinks.filter((_, idx) => idx !== i));
  };

  const updateLink = (i: number, field: "url" | "anchor_text", value: string) => {
    setAdditionalLinks(additionalLinks.map((l, idx) => idx === i ? { ...l, [field]: value } : l));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!spokesperson.trim()) { setError("Spokesperson name is required."); return; }
    if (!contactEmail.trim() || !contactEmail.includes("@")) { setError("A valid contact email is required."); return; }

    // Validate any additional links that have been partially filled
    for (const link of additionalLinks) {
      if ((link.url && !link.anchor_text) || (!link.url && link.anchor_text)) {
        setError("Each additional link needs both a URL and anchor text.");
        return;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit({
        spokesperson: spokesperson.trim(),
        contact_email: contactEmail.trim(),
        page_url: pageUrl.trim(),
        additional_links: additionalLinks.filter((l) => l.url && l.anchor_text),
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Generation failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground">Generate Press Release</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-xs">{pageTitle}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Spokesperson */}
          <div className="space-y-1.5">
            <Label htmlFor="spokesperson">Spokesperson name <span className="text-destructive">*</span></Label>
            <Input
              id="spokesperson"
              placeholder="e.g. John Smith"
              value={spokesperson}
              onChange={(e) => setSpokesperson(e.target.value)}
            />
          </div>

          {/* Contact email */}
          <div className="space-y-1.5">
            <Label htmlFor="contact_email">Contact email <span className="text-destructive">*</span></Label>
            <Input
              id="contact_email"
              type="email"
              placeholder="e.g. john@example.com"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </div>

          {/* Page URL */}
          <div className="space-y-1.5">
            <Label htmlFor="page_url">
              Page URL
              <span className="text-muted-foreground font-normal ml-1.5">(optional — defaults to homepage)</span>
            </Label>
            <Input
              id="page_url"
              type="url"
              placeholder="https://example.com/services/keyword"
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
            />
          </div>

          {/* Additional links */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>
                Additional links
                <span className="text-muted-foreground font-normal ml-1.5">(up to 2)</span>
              </Label>
              {canAddLink && (
                <button
                  type="button"
                  onClick={addLink}
                  className="text-xs text-accent hover:opacity-80 transition-opacity flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Add link
                </button>
              )}
            </div>

            {additionalLinks.map((link, i) => (
              <div key={i} className="bg-muted/30 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Link {i + 1}</span>
                  <button type="button" onClick={() => removeLink(i)} className="text-muted-foreground hover:text-destructive transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <Input
                  placeholder="Anchor text (e.g. Plumbing Services in Chicago)"
                  value={link.anchor_text}
                  onChange={(e) => updateLink(i, "anchor_text", e.target.value)}
                  className="text-sm"
                />
                <Input
                  type="url"
                  placeholder="https://example.com/page"
                  value={link.url}
                  onChange={(e) => updateLink(i, "url", e.target.value)}
                  className="text-sm"
                />
              </div>
            ))}

            {additionalLinks.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Add up to 2 branded anchor text links to include as placement reminders.
              </p>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex gap-3 pt-1">
            <Button
              type="submit"
              className="flex-1 bg-accent text-accent-foreground hover:opacity-90 font-semibold py-5"
              disabled={submitting}
            >
              {submitting
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating…</>
                : "Generate Press Release"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
