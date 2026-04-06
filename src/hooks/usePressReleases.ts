import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PressRelease {
  id: string;
  user_id: string;
  business_id: string;
  generated_page_id: string | null;
  keyword: string;
  location: string;
  page_title: string;
  page_url: string | null;
  status: "pending_user_approval" | "submitted" | "syndicated" | "report_uploaded";
  content_html: string | null;
  user_feedback: string | null;
  generation_count: number;
  submitted_at: string | null;
  syndicated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PressReleaseReport {
  id: string;
  press_release_id: string;
  pdf_url: string;
  pdf_filename: string;
  uploaded_by: string | null;
  uploaded_at: string;
}

export const PRESS_RELEASES_KEY = (businessId: string) =>
  ["press_releases", businessId] as const;

export const ALL_PRESS_RELEASES_KEY = ["press_releases", "all"] as const;

// ── User hooks ────────────────────────────────────────────────────────────────

export function usePressReleases(businessId: string | null) {
  return useQuery({
    queryKey: PRESS_RELEASES_KEY(businessId ?? ""),
    enabled: !!businessId,
    queryFn: async (): Promise<PressRelease[]> => {
      const { data, error } = await supabase
        .from("press_releases" as any)
        .select("*")
        .eq("business_id", businessId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data as PressRelease[]) ?? [];
    },
  });
}

export function usePressReleaseReports(pressReleaseId: string | null) {
  return useQuery({
    queryKey: ["press_release_reports", pressReleaseId],
    enabled: !!pressReleaseId,
    queryFn: async (): Promise<PressReleaseReport[]> => {
      const { data, error } = await supabase
        .from("press_release_reports" as any)
        .select("*")
        .eq("press_release_id", pressReleaseId!)
        .order("uploaded_at", { ascending: false });
      if (error) throw error;
      return (data as PressReleaseReport[]) ?? [];
    },
  });
}

export function useCreatePressRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      business_id: string;
      generated_page_id: string;
      keyword: string;
      location: string;
      page_title: string;
      content_html: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from("press_releases" as any)
        .insert({
          ...payload,
          user_id: user.id,
          status: "pending_user_approval",
          generation_count: 1,
        })
        .select()
        .single();
      if (error) throw error;
      return data as PressRelease;
    },
    onSuccess: (pr) => {
      qc.invalidateQueries({ queryKey: PRESS_RELEASES_KEY(pr.business_id) });
    },
  });
}

export function useApprovePressRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("press_releases" as any)
        .update({
          status: "submitted",
          submitted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as PressRelease;
    },
    onSuccess: (pr) => {
      qc.invalidateQueries({ queryKey: PRESS_RELEASES_KEY(pr.business_id) });
      qc.invalidateQueries({ queryKey: ALL_PRESS_RELEASES_KEY });
    },
  });
}

export function useRequestChanges() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, feedback, new_content_html }: { id: string; feedback: string; new_content_html: string }) => {
      const { data: current, error: fetchErr } = await supabase
        .from("press_releases" as any)
        .select("generation_count, business_id")
        .eq("id", id)
        .single();
      if (fetchErr) throw fetchErr;
      const pr = current as { generation_count: number; business_id: string };

      const { data, error } = await supabase
        .from("press_releases" as any)
        .update({
          status: "pending_user_approval",
          user_feedback: feedback,
          generation_count: pr.generation_count + 1,
          content_html: new_content_html,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as PressRelease;
    },
    onSuccess: (pr) => {
      qc.invalidateQueries({ queryKey: PRESS_RELEASES_KEY(pr.business_id) });
    },
  });
}

// ── Admin hooks ───────────────────────────────────────────────────────────────

export function useAllPressReleases() {
  return useQuery({
    queryKey: ALL_PRESS_RELEASES_KEY,
    queryFn: async (): Promise<(PressRelease & { business_name?: string })[]> => {
      const { data, error } = await supabase
        .from("press_releases" as any)
        .select("*, business_profiles(business_name)")
        .in("status", ["submitted", "syndicated", "report_uploaded"])
        .order("submitted_at", { ascending: true });
      if (error) throw error;
      return ((data as any[]) ?? []).map((r) => ({
        ...r,
        business_name: r.business_profiles?.business_name ?? "",
      }));
    },
  });
}

export function useMarkSyndicated() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("press_releases" as any)
        .update({
          status: "syndicated",
          syndicated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_PRESS_RELEASES_KEY });
    },
  });
}

export function useUploadReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      pressReleaseId,
      userId,
      file,
      message,
      keyword,
      businessName,
    }: {
      pressReleaseId: string;
      userId: string;
      file: File;
      message: string;
      keyword: string;
      businessName: string;
    }) => {
      const path = `${pressReleaseId}/${Date.now()}-${file.name}`;
      const { error: uploadErr } = await supabase.storage
        .from("press-release-reports")
        .upload(path, file, { contentType: "application/pdf" });
      if (uploadErr) throw uploadErr;

      const { data: { user: adminUser } } = await supabase.auth.getUser();

      // Store the storage path (not a public URL) — download links use signed URLs
      const { error: insertErr } = await supabase
        .from("press_release_reports" as any)
        .insert({
          press_release_id: pressReleaseId,
          pdf_url: path,
          pdf_filename: file.name,
          uploaded_by: adminUser?.id ?? null,
        });
      if (insertErr) throw insertErr;

      // Update PR status
      const { error: updateErr } = await supabase
        .from("press_releases" as any)
        .update({
          status: "report_uploaded",
          updated_at: new Date().toISOString(),
        })
        .eq("id", pressReleaseId);
      if (updateErr) throw updateErr;

      // Notify the user
      const title = `Your press release has been syndicated${businessName ? ` — ${businessName}` : ""}`;
      const body = message || `Your press release for "${keyword}" has been syndicated. Download your report in the Press Releases tab.`;
      const { error: notifErr } = await supabase
        .from("notifications" as any)
        .insert({
          user_id: userId,
          created_by: adminUser?.id ?? null,
          related_pr_id: pressReleaseId,
          title,
          body,
        });
      if (notifErr) throw notifErr;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_PRESS_RELEASES_KEY });
    },
  });
}
