import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '';
if (!ALLOWED_ORIGIN) {
  console.warn(
    '[google-places] ALLOWED_ORIGIN is not set. ' +
    'Set it in Supabase function secrets to your frontend URL (e.g. https://yourapp.lovable.app). ' +
    'Falling back to wildcard — configure this before going to production.'
  );
}
const _corsOrigin = ALLOWED_ORIGIN || '*';
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const corsHeaders = {
  'Access-Control-Allow-Origin': _corsOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const OUTSCRAPER_BASE = 'https://api.app.outscraper.com';
const DATAFORSEO_BASE = 'https://api.dataforseo.com/v3';

const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Require a valid Supabase JWT — protects Outscraper API key from public abuse
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return unauthorized();
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return unauthorized();

  const apiKey = Deno.env.get('OUTSCRAPER_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Outscraper API key not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { action, input, place_id } = await req.json();

    if (!action) {
      return new Response(JSON.stringify({ error: 'Missing action parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'autocomplete') {
      if (!input || typeof input !== 'string' || input.trim().length < 2) {
        return new Response(JSON.stringify({ error: 'Input must be at least 2 characters' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Use Outscraper maps search with limit=5 for autocomplete-like behavior
      const params = new URLSearchParams({
        query: input.trim(),
        organizationsPerQueryLimit: '5',
        language: 'en',
        async: 'false',
      });

      const response = await fetch(`${OUTSCRAPER_BASE}/maps/search-v3?${params}`, {
        headers: {
          'X-API-KEY': apiKey,
          'client': 'Lovable',
        },
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Outscraper search failed [${response.status}]: ${JSON.stringify(data)}`);
      }

      // data.data is an array of arrays: [[place1, place2, ...]]
      const places = (data.data && data.data[0]) || [];

      const suggestions = places.map((p: any) => {
        const fullAddress = p.full_address || p.address || '';
        const cityFallback = [p.city, p.state].filter(Boolean).join(', ');
        const displayAddress = fullAddress || cityFallback;
        return {
          place_id: p.place_id || p.google_id || '',
          name: p.name || '',
          address: displayAddress,
          description: `${p.name || ''}, ${displayAddress}`,
        };
      });

      return new Response(JSON.stringify({ suggestions }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'details') {
      if (!place_id || typeof place_id !== 'string') {
        return new Response(JSON.stringify({ error: 'Missing or invalid place_id' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Look up by place_id directly — request up to 5 reviews
      const params = new URLSearchParams({
        query: place_id,
        organizationsPerQueryLimit: '1',
        language: 'en',
        async: 'false',
        reviewsLimit: '5',
      });

      const response = await fetch(`${OUTSCRAPER_BASE}/maps/search-v3?${params}`, {
        headers: {
          'X-API-KEY': apiKey,
          'client': 'Lovable',
        },
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Outscraper details failed [${response.status}]: ${JSON.stringify(data)}`);
      }

      const places = (data.data && data.data[0]) || [];
      const p = places[0];

      if (!p) {
        return new Response(JSON.stringify({ error: 'Place not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Extract categories - Outscraper returns category and subtypes
      // subtypes may be a comma-separated string or an array
      const primaryCategory = p.category || p.category_name || p.type || '';
      let rawSubtypes: string[];
      if (Array.isArray(p.subtypes)) {
        rawSubtypes = p.subtypes;
      } else if (typeof p.subtypes === 'string' && p.subtypes) {
        rawSubtypes = p.subtypes.split(',').map((s: string) => s.trim()).filter(Boolean);
      } else {
        rawSubtypes = [];
      }
      const additionalCategories = rawSubtypes.filter((t: string) => t.toLowerCase() !== primaryCategory.toLowerCase());

      // Decode the website URL — Outscraper sometimes returns query strings
      // double-encoded (e.g. %3F instead of ?).
      const rawSite = p.site || p.website || '';
      let cleanWebsite = '';
      if (rawSite) {
        let decoded = rawSite;
        try {
          decoded = decodeURIComponent(rawSite);
        } catch {
          decoded = rawSite;
        }
        // Only store http/https URLs — reject anything else (data:, javascript:, etc.)
        cleanWebsite = /^https?:\/\//i.test(decoded) ? decoded : '';
      }

      // Fetch reviews via DataForSEO (preferred) or fall back to Outscraper reviews_data
      const dfsLogin = Deno.env.get('DATAFORSEO_LOGIN');
      const dfsPassword = Deno.env.get('DATAFORSEO_PASSWORD');
      const gbpPlaceId = p.place_id || p.google_id || '';

      let reviews: any[] = [];

      if (dfsLogin && dfsPassword && gbpPlaceId) {
        try {
          const dfsAuth = btoa(`${dfsLogin}:${dfsPassword}`);
          const dfsResp = await fetch(`${DATAFORSEO_BASE}/business_data/google/reviews/live`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${dfsAuth}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify([{
              place_id: gbpPlaceId,
              depth: 10,
              sort_by: 'most_relevant',
              language_name: 'English',
            }]),
          });
          if (dfsResp.ok) {
            const dfsData = await dfsResp.json();
            const items: any[] = dfsData?.tasks?.[0]?.result?.[0]?.items ?? [];
            reviews = items
              .filter((r: any) => r.review_text && (r.review_rating?.value ?? r.rating ?? 0) >= 4)
              .slice(0, 5)
              .map((r: any) => ({
                reviewer: r.profile_name || r.author_title || 'Anonymous',
                rating: r.review_rating?.value ?? r.rating ?? 5,
                text: r.review_text,
                date: r.timestamp
                  ? r.timestamp.split('T')[0]
                  : (r.review_datetime_utc ? r.review_datetime_utc.split(' ')[0] : ''),
              }));
          }
        } catch (dfsErr) {
          console.warn('DataForSEO reviews fetch failed, falling back to Outscraper:', dfsErr);
        }
      }

      // Fallback: Outscraper reviews_data
      if (reviews.length === 0) {
        const rawReviews: any[] = Array.isArray(p.reviews_data) ? p.reviews_data : [];
        reviews = rawReviews
          .filter((r: any) => r.review_text && r.review_rating >= 4)
          .slice(0, 5)
          .map((r: any) => ({
            reviewer: r.author_title || 'Anonymous',
            rating: r.review_rating,
            text: r.review_text,
            date: r.review_datetime_utc
              ? r.review_datetime_utc.split(' ')[0]
              : '',
          }));
      }

      const details = {
        place_id: p.place_id || p.google_id || '',
        name: p.name || '',
        description: p.description || '',
        address: p.full_address || p.address || '',
        phone: p.phone || '',
        website: cleanWebsite,
        logo: p.logo || '',
        photo: p.photo || '',
        category: primaryCategory,
        categories: additionalCategories,
        types: p.type ? [p.type, ...rawSubtypes] : rawSubtypes,
        rating: p.rating ?? null,
        review_count: p.reviews ?? null,
        reviews,
        latitude: p.latitude ?? null,
        longitude: p.longitude ?? null,
        hours: p.working_hours ? Object.entries(p.working_hours).map(([day, hrs]) => `${day}: ${hrs}`) : null,
        google_maps_uri: p.location_link || p.google_maps_url || null,
      };

      return new Response(JSON.stringify({ details }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Invalid action. Use "autocomplete" or "details".' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('outscraper error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
