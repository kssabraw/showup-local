import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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
    if (!primaryUrl || !primaryKey) {
      throw new Error("Primary Supabase credentials not configured");
    }

    const primary = createClient(primaryUrl, primaryKey);

    // --- Write to external Supabase (optional — skipped if key not configured) ---
    const externalUrl = "https://yvdfiwabdvcpqwrmtysd.supabase.co";
    const externalKey = Deno.env.get("EXTERNAL_SUPABASE_SERVICE_ROLE_KEY");
    let externalError: { message: string } | null = null;

    if (externalKey) {
      const external = createClient(externalUrl, externalKey);
      const { error } = await external
        .from("business_profiles")
        .upsert(record, { onConflict: "gbp_place_id" });
      if (error) {
        externalError = error;
        console.error("External write failed (non-blocking):", error.message);
      }
    } else {
      console.warn("EXTERNAL_SUPABASE_SERVICE_ROLE_KEY not configured — skipping external write");
    }

    const primaryRecord = { ...record };
    const { data: primaryData, error: primaryError } = await primary
      .from("business_profiles")
      .upsert(primaryRecord, { onConflict: "gbp_place_id" })
      .select()
      .single();

    if (primaryError) {
      throw new Error(`Primary write failed: ${primaryError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: primaryData,
        external_synced: !externalError,
        external_error: externalError?.message || null,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("dual-write error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
