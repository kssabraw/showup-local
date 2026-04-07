export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      business_profiles: {
        Row: {
          address: string
          analysis_status: string | null
          brand_voice: Json | null
          business_name: string
          created_at: string
          description: string | null
          detected_icp: Json | null
          differentiators: Json | null
          existing_pages: Json | null
          external_synced: boolean
          gbp_categories: Json
          gbp_category: string
          gbp_place_id: string
          gbp_rating: number | null
          gbp_review_count: number | null
          google_maps_uri: string | null
          hours: Json | null
          id: string
          latitude: number | null
          logo: string | null
          longitude: number | null
          phone: string | null
          photo: string | null
          reviews: Json | null
          updated_at: string
          user_id: string | null
          website: string | null
        }
        Insert: {
          address: string
          analysis_status?: string | null
          brand_voice?: Json | null
          business_name: string
          created_at?: string
          description?: string | null
          detected_icp?: Json | null
          differentiators?: Json | null
          existing_pages?: Json | null
          external_synced?: boolean
          gbp_categories?: Json
          gbp_category?: string
          gbp_place_id: string
          gbp_rating?: number | null
          gbp_review_count?: number | null
          google_maps_uri?: string | null
          hours?: Json | null
          id?: string
          latitude?: number | null
          logo?: string | null
          longitude?: number | null
          phone?: string | null
          photo?: string | null
          reviews?: Json | null
          updated_at?: string
          user_id?: string | null
          website?: string | null
        }
        Update: {
          address?: string
          analysis_status?: string | null
          brand_voice?: Json | null
          business_name?: string
          created_at?: string
          description?: string | null
          detected_icp?: Json | null
          differentiators?: Json | null
          existing_pages?: Json | null
          external_synced?: boolean
          gbp_categories?: Json
          gbp_category?: string
          gbp_place_id?: string
          gbp_rating?: number | null
          gbp_review_count?: number | null
          google_maps_uri?: string | null
          hours?: Json | null
          id?: string
          latitude?: number | null
          logo?: string | null
          longitude?: number | null
          phone?: string | null
          photo?: string | null
          reviews?: Json | null
          updated_at?: string
          user_id?: string | null
          website?: string | null
        }
        Relationships: []
      }
      generated_pages: {
        Row: {
          business_id: string
          composite_score: number | null
          composite_status: string | null
          content_gaps: Json | null
          content_html: string
          created_at: string
          id: string
          keyword: string
          location: string
          mode: string
          page_title: string | null
          schema_json: string | null
          scored_at: string | null
          social_posts: Json | null
          updated_at: string
        }
        Insert: {
          business_id: string
          composite_score?: number | null
          composite_status?: string | null
          content_gaps?: Json | null
          content_html: string
          created_at?: string
          id?: string
          keyword: string
          location: string
          mode?: string
          page_title?: string | null
          schema_json?: string | null
          scored_at?: string | null
          social_posts?: Json | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          composite_score?: number | null
          composite_status?: string | null
          content_gaps?: Json | null
          content_html?: string
          created_at?: string
          id?: string
          keyword?: string
          location?: string
          mode?: string
          page_title?: string | null
          schema_json?: string | null
          scored_at?: string | null
          social_posts?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_pages_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "business_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      keyword_analyses: {
        Row: {
          business_id: string
          competitor_headings: Json | null
          created_at: string
          google_entities: Json | null
          id: string
          keyword: string
          location: string
          related_keywords: Json | null
          serp_bold_keywords: Json | null
          serp_urls: Json | null
          top_quadgrams: Json | null
          updated_at: string
          zone_targets: Json
        }
        Insert: {
          business_id: string
          competitor_headings?: Json | null
          created_at?: string
          google_entities?: Json | null
          id?: string
          keyword: string
          location: string
          related_keywords?: Json | null
          serp_bold_keywords?: Json | null
          serp_urls?: Json | null
          top_quadgrams?: Json | null
          updated_at?: string
          zone_targets?: Json
        }
        Update: {
          business_id?: string
          competitor_headings?: Json | null
          created_at?: string
          google_entities?: Json | null
          id?: string
          keyword?: string
          location?: string
          related_keywords?: Json | null
          serp_bold_keywords?: Json | null
          serp_urls?: Json | null
          top_quadgrams?: Json | null
          updated_at?: string
          zone_targets?: Json
        }
        Relationships: [
          {
            foreignKeyName: "keyword_analyses_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "business_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      location: {
        Row: {
          location_code: number
          location_name: string
        }
        Insert: {
          location_code: number
          location_name: string
        }
        Update: {
          location_code?: number
          location_name?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string | null
          default_location: string | null
          id: string
          role: string
        }
        Insert: {
          created_at?: string | null
          default_location?: string | null
          id: string
          role?: string
        }
        Update: {
          created_at?: string | null
          default_location?: string | null
          id?: string
          role?: string
        }
        Relationships: []
      }
      team_members: {
        Row: {
          created_at: string
          email: string
          id: string
          name: string
          owner_user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          name?: string
          owner_user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          name?: string
          owner_user_id?: string
        }
        Relationships: []
      }
      token_usage: {
        Row: {
          business_id: string | null
          cost_usd: number | null
          created_at: string
          endpoint: string | null
          id: string
          input_tokens: number | null
          keyword: string | null
          model: string | null
          output_tokens: number | null
        }
        Insert: {
          business_id?: string | null
          cost_usd?: number | null
          created_at?: string
          endpoint?: string | null
          id?: string
          input_tokens?: number | null
          keyword?: string | null
          model?: string | null
          output_tokens?: number | null
        }
        Update: {
          business_id?: string | null
          cost_usd?: number | null
          created_at?: string
          endpoint?: string | null
          id?: string
          input_tokens?: number | null
          keyword?: string | null
          model?: string | null
          output_tokens?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_all_users: {
        Args: Record<PropertyKey, never>
        Returns: {
          id: string
          email: string
          created_at: string
          last_sign_in_at: string
          role: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
