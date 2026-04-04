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

const PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/nlp-proxy`;

async function getAuthHeader(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? `Bearer ${session.access_token}` : "";
}

// ── Core helpers ──────────────────────────────────────────────────────────────

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
    body: { keyword: string; location: string; gbp_category: string },
    signal?: AbortSignal,
  ) => nlpPost<RankabilityResult>("/check-rankability", body, signal),

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
