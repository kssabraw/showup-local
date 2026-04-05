import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NLP_SERVICE_URL = Deno.env.get("NLP_SERVICE_URL") ?? "";
const NLP_API_KEY = Deno.env.get("NLP_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Credits charged per endpoint (0 = free)
const ENDPOINT_CREDITS: Record<string, number> = {
  "/analyze":         2,
  "/score-page":      2,
  "/generate-page":   1,
  "/reoptimize-page": 1,
};

const ENDPOINT_DESCRIPTIONS: Record<string, string> = {
  "/analyze":         "Competitor analysis + scoring",
  "/score-page":      "Competitor analysis + scoring",
  "/generate-page":   "New page creation",
  "/reoptimize-page": "Page reoptimization",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  // Verify Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Auth client — uses the user's JWT to identify them
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Extract the NLP endpoint from the URL path
  const url = new URL(req.url);
  const pathMatch = url.pathname.match(/\/nlp-proxy(\/.*)?$/);
  const endpoint = pathMatch?.[1] || "/";

  // Only allow POST to known endpoints
  const allowedEndpoints = [
    "/analyze", "/analyze-business", "/analyze-brand-voice",
    "/score-page", "/generate-page", "/reoptimize-page",
    "/find-page-for-keyword", "/related-pages", "/check-rankability",
    "/plan-pages", "/health", "/generate-social-posts",
    "/generate-press-release",
  ];
  if (!allowedEndpoints.includes(endpoint)) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Service role client — reused for both credit deduction and rankability limit
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Credit check + deduction ─────────────────────────────────────────────────
  const creditsRequired = ENDPOINT_CREDITS[endpoint] ?? 0;
  if (creditsRequired > 0) {
    const { data: ok, error: deductError } = await adminClient.rpc("deduct_credits", {
      p_user_id:    user.id,
      p_amount:     creditsRequired,
      p_endpoint:   endpoint,
      p_description: ENDPOINT_DESCRIPTIONS[endpoint] ?? endpoint,
    });

    if (deductError) {
      console.error("Credit deduction error:", deductError);
      return new Response(JSON.stringify({ error: "Could not process credits" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!ok) {
      return new Response(
        JSON.stringify({
          error: "Insufficient credits",
          credits_required: creditsRequired,
          code: "INSUFFICIENT_CREDITS",
        }),
        {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  }

  // ── Rankability monthly cap (50 checks/month, separate from credits) ─────────
  if (endpoint === "/check-rankability") {
    const { data: allowed, error: limitError } = await adminClient.rpc(
      "check_rankability_limit",
      { p_user_id: user.id },
    );

    if (limitError) {
      console.error("Rankability limit check error:", limitError);
      return new Response(JSON.stringify({ error: "Could not verify usage limit" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!allowed) {
      return new Response(
        JSON.stringify({
          error: "Monthly map pack check limit reached",
          code: "RANKABILITY_LIMIT_REACHED",
          limit: 50,
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  }

  // ── Forward request to NLP service ───────────────────────────────────────────
  try {
    const nlpResponse = await fetch(`${NLP_SERVICE_URL}${endpoint}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": NLP_API_KEY,
      },
      body: req.method !== "GET" ? req.body : undefined,
      // @ts-ignore - Deno supports duplex streaming
      duplex: "half",
    });

    // Forward the response (including streaming SSE responses)
    const responseHeaders = new Headers(corsHeaders);
    const contentType = nlpResponse.headers.get("Content-Type");
    if (contentType) responseHeaders.set("Content-Type", contentType);

    return new Response(nlpResponse.body, {
      status: nlpResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("NLP proxy error:", err);
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
