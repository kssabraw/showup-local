import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type SavedPage = Pick<
  Tables<"generated_pages">,
  | "id"
  | "business_id"
  | "keyword"
  | "location"
  | "mode"
  | "page_title"
  | "content_html"
  | "schema_json"
  | "created_at"
  | "composite_score"
  | "composite_status"
  | "social_posts"
  | "content_gaps"
>;

const PAGE_SIZE = 25;

export const SAVED_PAGES_KEY = ["saved_pages"] as const;

export function useSavedPages(page = 0) {
  return useQuery({
    queryKey: [...SAVED_PAGES_KEY, page],
    queryFn: async (): Promise<{ pages: SavedPage[]; hasMore: boolean }> => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, error } = await supabase
        .from("generated_pages")
        .select(
          "id, business_id, keyword, location, mode, page_title, content_html, schema_json, created_at, composite_score, composite_status, social_posts, content_gaps",
        )
        .order("created_at", { ascending: false })
        .range(from, to + 1); // fetch one extra to detect hasMore
      if (error) throw error;
      const rows = (data as SavedPage[]) ?? [];
      return {
        pages: rows.slice(0, PAGE_SIZE),
        hasMore: rows.length > PAGE_SIZE,
      };
    },
  });
}

/** Call after saving/deleting a page to refresh saved pages and dashboard stats. */
export function useInvalidateSavedPages() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: SAVED_PAGES_KEY });
    qc.invalidateQueries({ queryKey: ["dashboard_stats"] });
  };
}
