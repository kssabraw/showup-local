/**
 * purchase-credit-pack
 *
 * Creates a Stripe Checkout session for a credit top-up pack.
 *
 * ── Stripe integration (TODO when going live) ────────────────────────────────
 * 1. import Stripe from "https://esm.sh/stripe@14"
 * 2. Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID_25, _60, _150 in Supabase secrets
 * 3. Set APP_URL in Supabase secrets
 * 4. Replace the stub block below with:
 *      const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-04-10" });
 *      const session = await stripe.checkout.sessions.create({ ... });
 *      return json({ checkout_url: session.url });
 * 5. Deploy stripe-webhook Edge Function to call fulfill_credit_pack() on payment
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const STRIPE_CONFIGURED = !!Deno.env.get("STRIPE_SECRET_KEY");

const VALID_PACKS: Record<string, { credits: number; amount_cents: number }> = {
  "25":  { credits: 25,  amount_cents: 1500 },
  "60":  { credits: 60,  amount_cents: 3500 },
  "150": { credits: 150, amount_cents: 8200 },
};

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors, status: 204 });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Unauthorized" }, 401);

  const { pack_id } = await req.json().catch(() => ({}));
  const pack = VALID_PACKS[pack_id];
  if (!pack) return json({ error: "Invalid pack" }, 400);

  // ── Stripe not yet configured ─────────────────────────────────────────────
  if (!STRIPE_CONFIGURED) {
    return json({
      checkout_url: null,
      message: "Payment processing is not yet configured. Please check back soon.",
    });
  }

  // ── TODO: Stripe Checkout session creation ────────────────────────────────
  // const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-04-10" });
  // const priceId = Deno.env.get(`STRIPE_PRICE_ID_${pack_id}`);
  // const session = await stripe.checkout.sessions.create({
  //   mode: "payment",
  //   line_items: [{ price: priceId, quantity: 1 }],
  //   metadata: { user_id: user.id, pack_credits: pack_id },
  //   success_url: `${Deno.env.get("APP_URL")}/purchase-success?session_id={CHECKOUT_SESSION_ID}`,
  //   cancel_url:  Deno.env.get("APP_URL"),
  // });
  // return json({ checkout_url: session.url });

  return json({ checkout_url: null, message: "Payment processing coming soon." });
});
