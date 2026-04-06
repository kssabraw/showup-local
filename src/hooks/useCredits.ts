import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CreditsData {
  balance: number;          // combined: monthly + bonus
  monthlyBalance: number;
  bonusCredits: number;
  perMonth: number;
  plan: string;
  prCredits: number;        // press release credits (purchased separately)
  rankabilityUsed: number;  // map pack checks used this month
  rankabilityLimit: number; // map pack checks allowed per month
}

async function fetchCredits(): Promise<CreditsData> {
  const { data: { user } } = await supabase.auth.getUser();

  const [profileRes, rankabilityRes] = await Promise.all([
    supabase.from("user_profiles").select("credits_balance, bonus_credits, credits_per_month, plan, pr_credits").single(),
    user ? supabase.rpc("get_rankability_usage", { p_user_id: user.id }) : Promise.resolve({ data: null, error: null }),
  ]);

  const profile = profileRes.data;
  if (!profile) {
    const { data: balance } = await supabase.rpc("get_credits");
    return { balance: balance ?? 0, monthlyBalance: balance ?? 0, bonusCredits: 0, perMonth: 60, plan: "starter", prCredits: 0, rankabilityUsed: 0, rankabilityLimit: 50 };
  }

  const monthly = profile.credits_balance ?? 0;
  const bonus   = (profile as { bonus_credits?: number }).bonus_credits ?? 0;
  const rankability = (rankabilityRes.data as { used?: number; limit?: number } | null);
  return {
    balance:          monthly + bonus,
    monthlyBalance:   monthly,
    bonusCredits:     bonus,
    perMonth:         profile.credits_per_month,
    plan:             profile.plan,
    prCredits:        (profile as { pr_credits?: number }).pr_credits ?? 0,
    rankabilityUsed:  rankability?.used  ?? 0,
    rankabilityLimit: rankability?.limit ?? 50,
  };
}

export function useCredits() {
  return useQuery({
    queryKey: ["credits"],
    queryFn: fetchCredits,
    staleTime: 30_000,       // treat as fresh for 30s
    refetchOnWindowFocus: true,
  });
}

export function useInvalidateCredits() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["credits"] });
}
