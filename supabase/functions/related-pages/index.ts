import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NLP_SERVICE_URL = Deno.env.get("NLP_SERVICE_URL") ?? "";
const NLP_API_KEY = Deno.env.get("NLP_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

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

  try {
    const nlpResponse = await fetch(`${NLP_SERVICE_URL}/related-pages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": NLP_API_KEY,
        "X-User-ID": user.id,
      },
      body: req.body,
      // @ts-ignore
      duplex: "half",
    });

    const responseHeaders = new Headers(corsHeaders);
    const contentType = nlpResponse.headers.get("Content-Type");
    if (contentType) responseHeaders.set("Content-Type", contentType);

    return new Response(nlpResponse.body, {
      status: nlpResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("related-pages proxy error:", err);
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
