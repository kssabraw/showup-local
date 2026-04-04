import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CreditsData {
  balance: number;
  perMonth: number;
  plan: string;
}

async function fetchCredits(): Promise<CreditsData> {
  // Try user_profiles directly first (more data)
  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("credits_balance, credits_per_month, plan")
    .single();

  if (error || !profile) {
    // Fall back to the get_credits() RPC if profile row doesn't exist yet
    const { data: balance } = await supabase.rpc("get_credits");
    return { balance: balance ?? 0, perMonth: 60, plan: "starter" };
  }

  return {
    balance: profile.credits_balance,
    perMonth: profile.credits_per_month,
    plan: profile.plan,
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
