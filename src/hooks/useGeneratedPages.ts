import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type GeneratedPage = Pick<
  Tables<"generated_pages">,
  | "id"
  | "business_id"
  | "keyword"
  | "location"
  | "mode"
  | "page_title"
  | "composite_score"
  | "composite_status"
  | "created_at"
>;

export const GENERATED_PAGES_KEY = (businessId: string) =>
  ["generated_pages", businessId] as const;

export function useGeneratedPages(businessId: string | null) {
  return useQuery({
    queryKey: GENERATED_PAGES_KEY(businessId ?? ""),
    enabled: !!businessId,
    queryFn: async (): Promise<GeneratedPage[]> => {
      const { data, error } = await supabase
        .from("generated_pages")
        .select(
          "id, business_id, keyword, location, mode, page_title, composite_score, composite_status, created_at",
        )
        .eq("business_id", businessId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data as GeneratedPage[]) ?? [];
    },
  });
}
