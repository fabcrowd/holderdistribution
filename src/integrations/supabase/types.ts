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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          id: string
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string | null
          value: Json
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      council_members: {
        Row: {
          council_type: Database["public"]["Enums"]["council_type"]
          country: string | null
          created_at: string
          forum_application_url: string
          id: string
          member_handle: string | null
          member_name: string
          miner_group: Database["public"]["Enums"]["miner_group"]
          social_links: Json | null
          summary: string
          term_end_date: string
          term_start_date: string
          updated_at: string
        }
        Insert: {
          council_type: Database["public"]["Enums"]["council_type"]
          country?: string | null
          created_at?: string
          forum_application_url: string
          id?: string
          member_handle?: string | null
          member_name: string
          miner_group: Database["public"]["Enums"]["miner_group"]
          social_links?: Json | null
          summary: string
          term_end_date: string
          term_start_date: string
          updated_at?: string
        }
        Update: {
          council_type?: Database["public"]["Enums"]["council_type"]
          country?: string | null
          created_at?: string
          forum_application_url?: string
          id?: string
          member_handle?: string | null
          member_name?: string
          miner_group?: Database["public"]["Enums"]["miner_group"]
          social_links?: Json | null
          summary?: string
          term_end_date?: string
          term_start_date?: string
          updated_at?: string
        }
        Relationships: []
      }
      election_candidates: {
        Row: {
          application_date: string | null
          candidate_handle: string | null
          candidate_name: string
          council_type: Database["public"]["Enums"]["council_type"]
          country: string | null
          created_at: string
          forum_application_url: string
          id: string
          miner_group: Database["public"]["Enums"]["miner_group"]
          social_links: Json | null
          summary: string
          updated_at: string
        }
        Insert: {
          application_date?: string | null
          candidate_handle?: string | null
          candidate_name: string
          council_type: Database["public"]["Enums"]["council_type"]
          country?: string | null
          created_at?: string
          forum_application_url: string
          id?: string
          miner_group: Database["public"]["Enums"]["miner_group"]
          social_links?: Json | null
          summary: string
          updated_at?: string
        }
        Update: {
          application_date?: string | null
          candidate_handle?: string | null
          candidate_name?: string
          council_type?: Database["public"]["Enums"]["council_type"]
          country?: string | null
          created_at?: string
          forum_application_url?: string
          id?: string
          miner_group?: Database["public"]["Enums"]["miner_group"]
          social_links?: Json | null
          summary?: string
          updated_at?: string
        }
        Relationships: []
      }
      events: {
        Row: {
          created_at: string
          description: string
          end_date: string | null
          event_type: string
          event_url: string | null
          exception_dates: Json | null
          id: string
          location: string | null
          recurrence_pattern: string | null
          start_date: string
          timezone: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description: string
          end_date?: string | null
          event_type: string
          event_url?: string | null
          exception_dates?: Json | null
          id?: string
          location?: string | null
          recurrence_pattern?: string | null
          start_date: string
          timezone: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          end_date?: string | null
          event_type?: string
          event_url?: string | null
          exception_dates?: Json | null
          id?: string
          location?: string | null
          recurrence_pattern?: string | null
          start_date?: string
          timezone?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      home_tile_visibility: {
        Row: {
          id: string
          is_visible: boolean
          tile_identifier: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          id?: string
          is_visible?: boolean
          tile_identifier: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          id?: string
          is_visible?: boolean
          tile_identifier?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: []
      }
      home_tiles: {
        Row: {
          background_fit: string
          background_image_url: string | null
          background_opacity: number
          badge: string | null
          created_at: string
          description: string
          href: string | null
          icon: string
          id: string
          is_featured: boolean
          is_visible: boolean
          link_type: Database["public"]["Enums"]["tile_link_type"]
          links: Json | null
          route_to: string | null
          section: string | null
          sort_order: number
          title: string
          updated_at: string
        }
        Insert: {
          background_fit?: string
          background_image_url?: string | null
          background_opacity?: number
          badge?: string | null
          created_at?: string
          description: string
          href?: string | null
          icon: string
          id?: string
          is_featured?: boolean
          is_visible?: boolean
          link_type: Database["public"]["Enums"]["tile_link_type"]
          links?: Json | null
          route_to?: string | null
          section?: string | null
          sort_order?: number
          title: string
          updated_at?: string
        }
        Update: {
          background_fit?: string
          background_image_url?: string | null
          background_opacity?: number
          badge?: string | null
          created_at?: string
          description?: string
          href?: string | null
          icon?: string
          id?: string
          is_featured?: boolean
          is_visible?: boolean
          link_type?: Database["public"]["Enums"]["tile_link_type"]
          links?: Json | null
          route_to?: string | null
          section?: string | null
          sort_order?: number
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      news_articles: {
        Row: {
          article_date: string | null
          category: Database["public"]["Enums"]["news_category"]
          created_at: string
          description: string
          id: string
          image_url: string | null
          link: string
          published_at: string | null
          slug: string
          title: string
          updated_at: string
          video_url: string | null
        }
        Insert: {
          article_date?: string | null
          category: Database["public"]["Enums"]["news_category"]
          created_at?: string
          description: string
          id?: string
          image_url?: string | null
          link: string
          published_at?: string | null
          slug: string
          title: string
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          article_date?: string | null
          category?: Database["public"]["Enums"]["news_category"]
          created_at?: string
          description?: string
          id?: string
          image_url?: string | null
          link?: string
          published_at?: string | null
          slug?: string
          title?: string
          updated_at?: string
          video_url?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string | null
          email: string | null
          full_name: string | null
          id: string
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id: string
        }
        Update: {
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      proposals: {
        Row: {
          created_at: string
          description: string
          discussed_date: string | null
          forum_url: string | null
          id: string
          snapshot_url: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description: string
          discussed_date?: string | null
          forum_url?: string | null
          id: string
          snapshot_url?: string | null
          status: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          discussed_date?: string | null
          forum_url?: string | null
          id?: string
          snapshot_url?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      tel_markets_cache: {
        Row: {
          cex_markets: Json
          dex_markets: Json
          id: string
          updated_at: string
        }
        Insert: {
          cex_markets?: Json
          dex_markets?: Json
          id?: string
          updated_at?: string
        }
        Update: {
          cex_markets?: Json
          dex_markets?: Json
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      tel_price_cache: {
        Row: {
          chart_data: Json | null
          cmc_rank: number | null
          current_price: number | null
          id: string
          market_cap_rank: number | null
          price_change_24h: number | null
          price_change_7d: number | null
          updated_at: string | null
        }
        Insert: {
          chart_data?: Json | null
          cmc_rank?: number | null
          current_price?: number | null
          id?: string
          market_cap_rank?: number | null
          price_change_24h?: number | null
          price_change_7d?: number | null
          updated_at?: string | null
        }
        Update: {
          chart_data?: Json | null
          cmc_rank?: number | null
          current_price?: number | null
          id?: string
          market_cap_rank?: number | null
          price_change_24h?: number | null
          price_change_7d?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      tel_token_cache: {
        Row: {
          data: Json
          id: string
          updated_at: string
        }
        Insert: {
          data: Json
          id?: string
          updated_at?: string
        }
        Update: {
          data?: Json
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      telx_pools_cache: {
        Row: {
          id: string
          pools: Json
          updated_at: string
        }
        Insert: {
          id?: string
          pools?: Json
          updated_at?: string
        }
        Update: {
          id?: string
          pools?: Json
          updated_at?: string
        }
        Relationships: []
      }
      twitter_feed_cache: {
        Row: {
          id: string
          tweets: Json
          updated_at: string
        }
        Insert: {
          id?: string
          tweets: Json
          updated_at?: string
        }
        Update: {
          id?: string
          tweets?: Json
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      wallet_transactions: {
        Row: {
          alerted_at: string | null
          block_number: number
          chain: string
          created_at: string | null
          direction: string
          from_address: string
          id: string
          timestamp: string
          to_address: string
          tx_hash: string
          value: string
          wallet_address: string
          wallet_label: string
        }
        Insert: {
          alerted_at?: string | null
          block_number: number
          chain: string
          created_at?: string | null
          direction: string
          from_address: string
          id?: string
          timestamp: string
          to_address: string
          tx_hash: string
          value: string
          wallet_address: string
          wallet_label: string
        }
        Update: {
          alerted_at?: string | null
          block_number?: number
          chain?: string
          created_at?: string | null
          direction?: string
          from_address?: string
          id?: string
          timestamp?: string
          to_address?: string
          tx_hash?: string
          value?: string
          wallet_address?: string
          wallet_label?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      refresh_tel_token_data_via_edge: { Args: never; Returns: undefined }
    }
    Enums: {
      app_role: "admin" | "user"
      council_type: "platform" | "treasury" | "tan" | "telx" | "compliance"
      miner_group: "Stakers" | "Liquidity Miners" | "Developers" | "Validators"
      news_category:
        | "News Article"
        | "Ecosystem"
        | "Governance"
        | "Insights"
        | "Press Release"
        | "Educational"
        | "Events"
        | "Community"
        | "Legislation"
      tile_link_type: "internal" | "external" | "multi-link"
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
    Enums: {
      app_role: ["admin", "user"],
      council_type: ["platform", "treasury", "tan", "telx", "compliance"],
      miner_group: ["Stakers", "Liquidity Miners", "Developers", "Validators"],
      news_category: [
        "News Article",
        "Ecosystem",
        "Governance",
        "Insights",
        "Press Release",
        "Educational",
        "Events",
        "Community",
        "Legislation",
      ],
      tile_link_type: ["internal", "external", "multi-link"],
    },
  },
} as const
