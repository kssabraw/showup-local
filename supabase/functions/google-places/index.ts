import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const OUTSCRAPER_BASE = 'https://api.app.outscraper.com';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

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

      const suggestions = places.map((p: any) => ({
        place_id: p.place_id || p.google_id || '',
        name: p.name || '',
        address: p.full_address || p.address || '',
        description: `${p.name || ''}, ${p.full_address || p.address || ''}`,
      }));

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

      // Look up by place_id directly
      const params = new URLSearchParams({
        query: place_id,
        organizationsPerQueryLimit: '1',
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
      const primaryCategory = p.category || p.type || '';
      const rawSubtypes = Array.isArray(p.subtypes) ? p.subtypes : (typeof p.subtypes === 'string' ? [p.subtypes] : []);
      const additionalCategories = rawSubtypes.filter((t: string) => t !== primaryCategory);

      const details = {
        place_id: p.place_id || p.google_id || '',
        name: p.name || '',
        description: p.description || '',
        address: p.full_address || p.address || '',
        phone: p.phone || '',
        website: p.site || '',
        logo: p.logo || '',
        photo: p.photo || '',
        category: primaryCategory,
        categories: additionalCategories,
        types: p.type ? [p.type, ...rawSubtypes] : rawSubtypes,
        rating: p.rating ?? null,
        review_count: p.reviews ?? null,
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
