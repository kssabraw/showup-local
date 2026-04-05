import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";
if (!ALLOWED_ORIGIN) {
  console.warn(
    "[dual-write-business] ALLOWED_ORIGIN is not set. " +
    "Set it in Supabase function secrets to your frontend URL (e.g. https://yourapp.lovable.app). " +
    "Falling back to wildcard — configure this before going to production."
  );
}
const _corsOrigin = ALLOWED_ORIGIN || "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": _corsOrigin,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Require a valid Supabase JWT — unauthenticated writes are not allowed
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const record = body.record;
    // address is intentionally not required — service area businesses (SABs)
    // hide their physical address in GBP and will have no address field.
    if (!record || !record.gbp_place_id || !record.business_name) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: gbp_place_id, business_name" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Write to Lovable Cloud (primary) ---
    const primaryUrl = Deno.env.get("SUPABASE_URL");
    const primaryKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!primaryUrl || !primaryKey || !anonKey) {
      throw new Error("Primary Supabase credentials not configured");
    }

    // Verify the JWT and extract the authenticated user's ID
    const anonClient = createClient(primaryUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const userId = user.id;

    const primary = createClient(primaryUrl, primaryKey);

    // --- Write to external Supabase (optional — skipped if key not configured) ---
    // URL is read from env so the project ID isn't hardcoded in source.
    const externalUrl = Deno.env.get("EXTERNAL_SUPABASE_URL");
    const externalKey = Deno.env.get("EXTERNAL_SUPABASE_SERVICE_ROLE_KEY");
    let externalSynced = false;

    if (externalUrl && externalKey) {
      const external = createClient(externalUrl, externalKey);
      const { error } = await external
        .from("business_profiles")
        .upsert(record, { onConflict: "gbp_place_id" });
      if (error) {
        console.error("External write failed (non-blocking):", error.message);
      } else {
        externalSynced = true;
      }
    } else {
      console.warn("External Supabase not configured — skipping external write");
    }

    const primaryRecord = { ...record, user_id: userId };
    const { data: primaryData, error: primaryError } = await primary
      .from("business_profiles")
      .upsert(primaryRecord, { onConflict: "gbp_place_id" })
      .select()
      .single();

    if (primaryError) {
      // Log full detail internally; don't expose DB error text to the client.
      console.error("Primary write failed:", primaryError.message, primaryError.code);
      throw new Error("Failed to save business profile");
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: primaryData,
        external_synced: externalSynced,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("dual-write error:", err);
    // Only surface the message for known/expected errors thrown above.
    // Generic fallback avoids leaking unexpected internal details.
    const isKnown = err instanceof Error && (
      err.message === "Failed to save business profile" ||
      err.message === "Primary Supabase credentials not configured"
    );
    const message = isKnown && err instanceof Error
      ? err.message
      : "An unexpected error occurred. Please try again.";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
