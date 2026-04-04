import type {
  AnalysisResult,
  ScoreResult,
  GeneratePageResult,
  ReoptimizeResult,
  RelatedPageItem,
  RankabilityResult,
  StreamEvent,
} from "./nlp-types";
import { supabase } from "@/integrations/supabase/client";

// ── Config ────────────────────────────────────────────────────────────────────
// Single source of truth — import these from here, not from env directly in components

export const NLP_SERVICE_URL =
  import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";

const PROXY_URL             = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/nlp-proxy`;
const PURCHASE_URL          = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/purchase-rankability-pack`;
const CREDIT_PURCHASE_URL   = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/purchase-credit-pack`;

async function getAuthHeader(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? `Bearer ${session.access_token}` : "";
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class InsufficientCreditsError extends Error {
  readonly creditsRequired: number;
  constructor(creditsRequired: number) {
    super(`Insufficient credits — this action requires ${creditsRequired} credit${creditsRequired !== 1 ? "s" : ""}`);
    this.name = "InsufficientCreditsError";
    this.creditsRequired = creditsRequired;
  }
}

export class RankabilityLimitError extends Error {
  readonly limit: number;
  constructor(limit = 50) {
    super(`You've used all ${limit} map pack checks for this month. Resets on the 1st.`);
    this.name = "RankabilityLimitError";
    this.limit = limit;
  }
}

// ── Core helpers ──────────────────────────────────────────────────────────────

function throwIfInsufficientCredits(res: Response, d: Record<string, unknown>) {
  if (res.status === 402) {
    throw new InsufficientCreditsError((d.credits_required as number) ?? 1);
  }
  if (res.status === 429 && (d as { code?: string }).code === "RANKABILITY_LIMIT_REACHED") {
    throw new RankabilityLimitError((d.limit as number) ?? 50);
  }
}

/** Non-streaming POST — resolves to JSON or throws a human-readable error. */
async function nlpPost<T>(
  endpoint: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const authHeader = await getAuthHeader();
  const res = await fetch(`${PROXY_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throwIfInsufficientCredits(res, d);
    throw new Error((d as { detail?: string; error?: string }).detail || (d as { detail?: string; error?: string }).error || `NLP error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Streaming POST — yields typed SSE events from /generate-page or
 * /reoptimize-page.  Each event is newline-delimited JSON prefixed "data: ".
 */
export async function* nlpStream<T>(
  endpoint: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent<T>> {
  const authHeader = await getAuthHeader();
  const res = await fetch(`${PROXY_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throwIfInsufficientCredits(res, d);
    throw new Error((d as { detail?: string; error?: string }).detail || (d as { detail?: string; error?: string }).error || `NLP error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        yield JSON.parse(line.slice(6)) as StreamEvent<T>;
      } catch {
        // skip malformed lines
      }
    }
  }
}

// ── Typed endpoint wrappers ───────────────────────────────────────────────────

export const nlp = {
  analyze: (
    body: { keyword: string; location: string; location_code?: number | null },
    signal?: AbortSignal,
  ) => nlpPost<AnalysisResult>("/analyze", body, signal),

  scorePage: (
    body: {
      keyword: string;
      location: string;
      location_code?: number | null;
      page_url: string;
      business_name: string;
      gbp_category: string;
      address: string;
      serp_analysis?: AnalysisResult;
    },
    signal?: AbortSignal,
  ) => nlpPost<ScoreResult>("/score-page", body, signal),

  generatePage: (
    body: {
      keyword: string;
      location: string;
      business_name: string;
      gbp_category: string;
      address: string;
      phone?: string | null;
      differentiators?: unknown[];
      brand_voice?: unknown;
      detected_icp?: unknown;
    },
    signal?: AbortSignal,
  ) => nlpStream<GeneratePageResult>("/generate-page", body, signal),

  reoptimizePage: (
    body: {
      keyword: string;
      location: string;
      existing_page_url: string;
      deficiencies: unknown[];
      business_name: string;
      gbp_category: string;
      address: string;
      phone?: string;
      serp_analysis?: AnalysisResult;
    },
    signal?: AbortSignal,
  ) => nlpStream<ReoptimizeResult>("/reoptimize-page", body, signal),

  findPageForKeyword: (
    body: { website_url: string; keyword: string; location: string },
    signal?: AbortSignal,
  ) =>
    nlpPost<{
      found: boolean;
      page?: { url: string; title: string; h1?: string };
      is_blog_post?: boolean;
    }>("/find-page-for-keyword", body, signal),

  relatedPages: (
    body: {
      keyword: string;
      location: string;
      business_name: string;
      gbp_category: string;
      address: string;
      website?: string | null;
    },
    signal?: AbortSignal,
  ) => nlpPost<{ items: RelatedPageItem[] }>("/related-pages", body, signal),

  checkRankability: (
    body: {
      keyword: string;
      location: string;
      location_code?: number | null;
      gbp_category: string;
      business_name?: string;
      business_address?: string | null;
      business_review_count?: number | null;
      business_lat?: number | null;
      business_lng?: number | null;
      website?: string | null;
    },
    signal?: AbortSignal,
  ) => nlpPost<RankabilityResult>("/check-rankability", body, signal),

  generateSocialPosts: (
    body: {
      keyword: string;
      location: string;
      business_name: string;
      gbp_category: string;
      address?: string;
      phone?: string;
      page_content: string;
      differentiators?: unknown[];
      detected_icp?: unknown;
      brand_voice?: unknown;
    },
    signal?: AbortSignal,
  ) => nlpPost<{ gbp: string[]; token_usage: Record<string, unknown> }>(
    "/generate-social-posts", body, signal,
  ),

  analyzeBusiness: (
    body: {
      website_url: string;
      business_name: string;
      gbp_category: string;
      gbp_categories: string[];
    },
    signal?: AbortSignal,
  ) => nlpPost<{
    existing_pages: unknown[];
    detected_icp: unknown;
    differentiators: unknown[];
    analysis_status: string;
  }>("/analyze-business", body, signal),
};

/** Purchase a credit top-up pack. Returns a Stripe Checkout URL once Stripe is configured. */
export async function purchaseCreditPack(
  pack_id: "25" | "60" | "150",
): Promise<{ checkout_url: string | null; message?: string }> {
  const authHeader = await getAuthHeader();
  const res = await fetch(CREDIT_PURCHASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({ pack_id }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as { error?: string }).error || `Purchase failed: ${res.status}`);
  }
  return res.json();
}

/** Purchase a map pack check top-up. Returns a Stripe Checkout URL once Stripe is configured. */
export async function purchaseRankabilityPack(
  pack_id: "5" | "10" | "20",
): Promise<{ checkout_url: string | null; message?: string }> {
  const authHeader = await getAuthHeader();
  const res = await fetch(PURCHASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({ pack_id }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as { error?: string }).error || `Purchase failed: ${res.status}`);
  }
  return res.json();
}
