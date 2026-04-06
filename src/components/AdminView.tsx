import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, CheckCircle, FileText, Clock, Send, ChevronDown, ChevronUp } from "lucide-react";
import {
  useAllPressReleases,
  useMarkSyndicated,
  useUploadReport,
  type PressRelease,
} from "@/hooks/usePressReleases";

const STATUS_LABEL: Record<PressRelease["status"], string> = {
  pending_user_approval: "Awaiting User Approval",
  submitted: "Pending Syndication",
  syndicated: "Syndicated",
  report_uploaded: "Report Uploaded",
};

const STATUS_COLOR: Record<PressRelease["status"], string> = {
  pending_user_approval: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  submitted: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  syndicated: "bg-green-500/10 text-green-600 border-green-500/20",
  report_uploaded: "bg-purple-500/10 text-purple-600 border-purple-500/20",
};

function PRRow({ pr }: { pr: PressRelease & { business_name?: string } }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showDeliverForm, setShowDeliverForm] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const markSyndicated = useMarkSyndicated();
  const uploadReport = useUploadReport();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf") {
      setUploadError("Only PDF files are accepted.");
      return;
    }
    setSelectedFile(file);
    setUploadError("");
  };

  const handleDeliver = async () => {
    if (!selectedFile) { setUploadError("Please select a PDF report."); return; }
    if (!message.trim()) { setUploadError("Please add a message for the client."); return; }

    setUploading(true);
    setUploadError("");
    try {
      await uploadReport.mutateAsync({
        pressReleaseId: pr.id,
        userId: pr.user_id,
        file: selectedFile,
        message: message.trim(),
        keyword: pr.keyword,
        businessName: pr.business_name ?? "",
      });
      setShowDeliverForm(false);
      setMessage("");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch {
      setUploadError("Delivery failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="px-6 py-5 space-y-3">
      {/* PR info */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            {pr.page_title || pr.keyword}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {pr.business_name && (
              <span className="font-medium text-foreground/70">{pr.business_name} · </span>
            )}
            {pr.keyword} · {pr.location.split(",")[0]}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Submitted: {pr.submitted_at ? new Date(pr.submitted_at).toLocaleDateString() : "—"}
            {pr.syndicated_at && ` · Syndicated: ${new Date(pr.syndicated_at).toLocaleDateString()}`}
          </p>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${STATUS_COLOR[pr.status]}`}>
          {STATUS_LABEL[pr.status]}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        {pr.status === "submitted" && (
          <Button
            variant="outline"
            size="sm"
            className="text-green-600 border-green-500/30 hover:bg-green-500/10"
            onClick={() => markSyndicated.mutate(pr.id)}
            disabled={markSyndicated.isPending}
          >
            {markSyndicated.isPending
              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Marking…</>
              : <><CheckCircle className="w-3.5 h-3.5 mr-1.5" /> Mark Syndicated</>}
          </Button>
        )}

        {(pr.status === "syndicated" || pr.status === "report_uploaded") && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDeliverForm((v) => !v)}
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {pr.status === "report_uploaded" ? "Send Another Report" : "Upload & Notify Client"}
            {showDeliverForm
              ? <ChevronUp className="w-3.5 h-3.5 ml-1.5" />
              : <ChevronDown className="w-3.5 h-3.5 ml-1.5" />}
          </Button>
        )}
      </div>

      {/* Deliver form */}
      {showDeliverForm && (
        <div className="bg-muted/30 rounded-xl border border-border p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Deliver Report to Client
          </p>

          {/* Message */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Message to client</label>
            <textarea
              className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
              rows={3}
              placeholder="e.g. Your press release has been syndicated to 47 news outlets. See the report attached for full placement details."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          {/* File picker */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Syndication report (PDF)</label>
            <div
              className="flex items-center gap-3 border border-dashed border-border rounded-lg px-4 py-3 cursor-pointer hover:bg-muted/40 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">
                {selectedFile ? selectedFile.name : "Click to select PDF…"}
              </span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>

          {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}

          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-accent text-accent-foreground hover:opacity-90 font-semibold"
              onClick={handleDeliver}
              disabled={uploading}
            >
              {uploading
                ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Sending…</>
                : <><Send className="w-3.5 h-3.5 mr-1.5" /> Send to Client</>}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setShowDeliverForm(false); setMessage(""); setSelectedFile(null); setUploadError(""); }}
              disabled={uploading}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminView() {
  const { data: pressReleases = [], isLoading } = useAllPressReleases();

  const submitted = pressReleases.filter((pr) => pr.status === "submitted");
  const syndicated = pressReleases.filter((pr) => pr.status === "syndicated" || pr.status === "report_uploaded");

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Admin — Press Releases</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage submitted press releases, mark syndications, and deliver reports to clients.
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading queue…</span>
        </div>
      )}

      {/* Pending syndication queue */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Pending Syndication</h2>
          {submitted.length > 0 && (
            <span className="ml-auto text-xs font-semibold bg-accent/10 text-accent px-2 py-0.5 rounded-full">
              {submitted.length}
            </span>
          )}
        </div>
        {!isLoading && submitted.length === 0 ? (
          <div className="px-6 py-8 text-center text-muted-foreground">
            <CheckCircle className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No press releases pending syndication.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {submitted.map((pr) => <PRRow key={pr.id} pr={pr} />)}
          </div>
        )}
      </div>

      {/* Syndicated */}
      {syndicated.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center gap-2">
            <FileText className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Syndicated</h2>
          </div>
          <div className="divide-y divide-border">
            {syndicated.map((pr) => <PRRow key={pr.id} pr={pr} />)}
          </div>
        </div>
      )}
    </div>
  );
}
