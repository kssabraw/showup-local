import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface DashboardStats {
  locations: number;
  totalContent: number;
  avgScore: number | null;
}

export const DASHBOARD_STATS_KEY = ["dashboard_stats"] as const;

export function useDashboardStats() {
  return useQuery({
    queryKey: DASHBOARD_STATS_KEY,
    queryFn: async (): Promise<DashboardStats> => {
      const [{ count: locations }, { count: totalContent }, { data: scored }] =
        await Promise.all([
          supabase
            .from("business_profiles")
            .select("id", { count: "exact", head: true }),
          supabase
            .from("generated_pages")
            .select("id", { count: "exact", head: true }),
          supabase
            .from("generated_pages")
            .select("composite_score")
            .not("composite_score", "is", null),
        ]);

      const avgScore =
        scored && scored.length > 0
          ? Math.round(
              scored.reduce((sum, p) => sum + (p.composite_score as number), 0) /
                scored.length,
            )
          : null;

      return {
        locations: locations ?? 0,
        totalContent: totalContent ?? 0,
        avgScore,
      };
    },
  });
}
