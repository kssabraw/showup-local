import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type BusinessProfile = Pick<
  Tables<"business_profiles">,
  | "id"
  | "business_name"
  | "address"
  | "gbp_category"
  | "website"
  | "phone"
  | "gbp_place_id"
  | "description"
  | "hours"
  | "reviews"
  | "differentiators"
  | "existing_pages"
  | "brand_voice"
  | "detected_icp"
  | "latitude"
  | "longitude"
  | "gbp_review_count"
  | "gbp_rating"
>;

export const BUSINESS_PROFILES_KEY = ["business_profiles"] as const;

export function useBusinessProfiles() {
  return useQuery({
    queryKey: BUSINESS_PROFILES_KEY,
    queryFn: async (): Promise<BusinessProfile[]> => {
      const { data, error } = await supabase
        .from("business_profiles")
        .select(
          "id, business_name, address, gbp_category, website, phone, gbp_place_id, description, hours, reviews, differentiators, existing_pages, brand_voice, detected_icp, latitude, longitude, gbp_review_count, gbp_rating",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data as BusinessProfile[]) ?? [];
    },
  });
}
