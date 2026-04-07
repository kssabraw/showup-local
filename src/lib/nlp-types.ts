// ── Streaming event types ─────────────────────────────────────────────────────
// Used by /generate-page and /reoptimize-page endpoints (SSE over fetch)

export interface StreamProgressEvent {
  progress?: number;
  message?: string;
  step?: never;
  result?: never;
}

export interface StreamErrorEvent {
  step: "error";
  message: string;
  progress?: number;
}

export interface StreamDoneEvent<T> {
  step: "done";
  result: T;
  progress?: number;
  message?: string;
}

export type StreamEvent<T> = StreamProgressEvent | StreamErrorEvent | StreamDoneEvent<T>;

// ── Analysis (SERP) ───────────────────────────────────────────────────────────

export interface KeywordItem {
  term: string;
  score: number;
  page_spread: number;
  page_spread_pct: number;
  type: "related";
}

export interface QuadgramItem {
  phrase: string;
  page_spread: number;
  page_spread_pct: number;
  similarity_score: number;
  type: "quadgram";
}

export interface EntityItem {
  name: string;
  entity_type: string;
  mean_salience: number;
  page_spread: number;
  page_spread_pct: number;
  recommended_mentions: number;
  type: "google_entity";
}

export interface HeadingItem {
  url: string;
  headings: string[];
}

export interface AnalysisResult {
  keyword: string;
  location: string;
  serp_urls: string[];
  /** Number of pages successfully scraped (may be less than serp_urls.length) */
  scraped_count?: number;
  related_keywords: {
    title: KeywordItem[];
    h1: KeywordItem[];
    h2_h3: KeywordItem[];
    body: KeywordItem[];
  };
  top_quadgrams: QuadgramItem[];
  google_entities: EntityItem[];
  zone_targets: Record<string, { target: number }>;
  competitor_headings: HeadingItem[];
  analysis_cost?: Record<string, number>;
}

// ── Token usage & cost ────────────────────────────────────────────────────────

export interface TokenUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  endpoint: string;
}

export interface CostBreakdown {
  dataforseo?: number;
  scrapeowl?: number;
  scrapeowl_pages?: number;
  google_nlp?: number;
  google_nlp_chars?: number;
  claude?: number;
  claude_model?: string;
  claude_input_tokens?: number;
  claude_output_tokens?: number;
  total?: number;
}

// ── Page generation ───────────────────────────────────────────────────────────

export interface ContentGap {
  category: string;
  missing: string;
  score_impact: "high" | "medium" | "low";
  why_important: string;
  how_to_add: string;
}

export interface GeneratePageResult {
  content_html: string;
  schema_json: string;
  page_title: string;
  composite_score?: number | null;
  token_usage: TokenUsage;
  cost_breakdown: CostBreakdown;
  serp_analysis?: AnalysisResult;
  content_gaps?: ContentGap[];
}

// ── Reoptimize ────────────────────────────────────────────────────────────────

export interface ReoptimizeResult {
  content_html: string;
  schema_json: string;
  token_usage: TokenUsage;
  html_css_notes?: string[];
  page_title?: string;
  cost_breakdown?: CostBreakdown;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export interface EngineScore {
  score: number;
  icp_detected?: string;
  issues: string[];
  recommendations: string[];
}

export interface ScoreResult {
  composite_score: number;
  composite_status: string;
  engine_scores: Record<string, EngineScore>;
  deficiencies: Array<{
    engine: string;
    engine_key: string;
    score: number;
    issues: string[];
    recommendations: string[];
  }>;
  token_usage: TokenUsage;
  serp_analysis?: AnalysisResult;   // present when analysis was run inline by /score-page
  analysis_cost?: Record<string, number>;
}

// ── Related pages ─────────────────────────────────────────────────────────────

export interface RelatedPageItem {
  keyword: string;
  group: "parents" | "siblings" | "children";
  status: "found" | "missing";
  url?: string;
  page_title?: string;
  composite_score?: number;
  composite_status?: string;
  engine_scores?: Record<string, EngineScore>;
  deficiencies?: Array<{ engine: string; issue: string; fix: string }>;
}

// ── Rankability ───────────────────────────────────────────────────────────────

export interface RankabilityCompetitor {
  name: string;
  rating?: number;
  review_count?: number;
  has_keyword_in_name: boolean;
}

export interface RankabilityResult {
  // Score
  score: number;
  verdict: string;          // "strong" | "moderate" | "difficult" | "very_difficult"
  score_breakdown: Record<string, number>;

  // Map pack
  has_map_pack: boolean;
  competitors: RankabilityCompetitor[];
  ranking_categories: Array<{ category: string; count: number }>;

  // Competition metrics
  min_reviews_in_pack?: number;
  max_reviews_in_pack?: number;
  avg_reviews_in_pack?: number;
  avg_rating_in_pack?: number;
  review_gap?: number;  // reviews needed to match weakest competitor

  // Category match
  category_match: string;     // "exact" | "partial" | "none"

  // Distance
  distance_miles?: number;
  distance_ok: boolean;

  // Keyword-in-name
  keyword_in_competitor_names: number;
  competitor_name_examples: string[];

  // Google Maps presence (top-10 via dedicated Maps endpoint)
  in_maps_results: boolean;
  maps_position?: number;  // 1–10 if found

  // SAB vs physical pack
  is_sab: boolean;
  sab_pack_mismatch: boolean;
  physical_competitors_in_pack: number;

  // Human-readable
  message: string;
  match_count: number;
  total_results: number;
}
