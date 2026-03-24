import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Google Places API key not configured' }), {
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

      const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
        },
        body: JSON.stringify({
          input: input.trim(),
          includedPrimaryTypes: ['establishment'],
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Google Places autocomplete failed [${response.status}]: ${JSON.stringify(data)}`);
      }

      const suggestions = (data.suggestions || [])
        .filter((s: any) => s.placePrediction)
        .map((s: any) => ({
          place_id: s.placePrediction.placeId,
          name: s.placePrediction.structuredFormat?.mainText?.text || '',
          address: s.placePrediction.structuredFormat?.secondaryText?.text || '',
          description: s.placePrediction.text?.text || '',
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

      const fields = [
        'id', 'displayName', 'formattedAddress', 'nationalPhoneNumber',
        'internationalPhoneNumber', 'websiteUri', 'primaryType',
        'types', 'rating', 'userRatingCount', 'currentOpeningHours',
        'regularOpeningHours', 'location', 'primaryTypeDisplayName',
      ].join(',');

      const response = await fetch(
        `https://places.googleapis.com/v1/places/${place_id}`,
        {
          headers: {
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': fields,
          },
        }
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Google Places details failed [${response.status}]: ${JSON.stringify(data)}`);
      }

      const details = {
        place_id: data.id,
        name: data.displayName?.text || '',
        address: data.formattedAddress || '',
        phone: data.nationalPhoneNumber || data.internationalPhoneNumber || '',
        website: data.websiteUri || '',
        category: data.primaryTypeDisplayName?.text || data.primaryType || '',
        types: data.types || [],
        rating: data.rating || null,
        review_count: data.userRatingCount || null,
        latitude: data.location?.latitude || null,
        longitude: data.location?.longitude || null,
        hours: data.regularOpeningHours?.weekdayDescriptions || null,
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
    console.error('google-places error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
