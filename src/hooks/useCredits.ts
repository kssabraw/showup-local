import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CreditsData {
  balance: number;       // combined: monthly + bonus
  monthlyBalance: number;
  bonusCredits: number;
  perMonth: number;
  plan: string;
}

async function fetchCredits(): Promise<CreditsData> {
  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("credits_balance, bonus_credits, credits_per_month, plan")
    .single();

  if (error || !profile) {
    const { data: balance } = await supabase.rpc("get_credits");
    return { balance: balance ?? 0, monthlyBalance: balance ?? 0, bonusCredits: 0, perMonth: 60, plan: "starter" };
  }

  const monthly = profile.credits_balance ?? 0;
  const bonus   = (profile as { bonus_credits?: number }).bonus_credits ?? 0;
  return {
    balance:        monthly + bonus,
    monthlyBalance: monthly,
    bonusCredits:   bonus,
    perMonth:       profile.credits_per_month,
    plan:           profile.plan,
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
