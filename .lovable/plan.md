

# Plan: GBP Business Search with Google Places Autocomplete

## Overview

Build the first step of the Generate Mode flow: a business search page where users type their business name and see Google Places autocomplete suggestions, then confirm their GBP details.

## What We Need

**Google Places API** -- Yes, you're right. The spec explicitly calls for Google Places API autocomplete (SPEC.md, Step 1 of Generate Mode). This requires a Google API key with the Places API enabled.

## Architecture

```text
User types business name
        ↓
Edge Function (proxies to Google Places API)
        ↓
Autocomplete results returned
        ↓
User selects business → Place Details fetched
        ↓
GBP Confirmation Screen (name, address, phone, categories, hours)
        ↓
User confirms → data stored in session state
```

## Steps

### 1. Get Google Places API Key
- You'll need a Google Cloud project with the Places API (New) enabled
- We'll store the API key as a backend secret so it's never exposed to the browser

### 2. Create Edge Function: `google-places`
- Two endpoints via query param:
  - `?action=autocomplete&input=...` — calls Places Autocomplete, returns suggestions
  - `?action=details&place_id=...` — calls Place Details, returns full GBP data (name, address, phone, website, categories, hours, rating)
- CORS headers included
- Input validation with request body checks

### 3. Build Search Page Component (`BusinessSearchView.tsx`)
- Full-page search input with debounced autocomplete (300ms)
- Dropdown showing matching business results (name + address)
- On select: fetch place details and show confirmation screen

### 4. Build GBP Confirmation Screen (`GBPConfirmation.tsx`)
- Displays: business name, full address, phone, website, categories, hours, rating
- Two buttons: **Confirm & Continue** / **Search Again**
- On confirm: store GBP data in component state and advance to next step

### 5. Wire into App Routing
- Add to Index.tsx as a new `activeItem` state ("generate")
- Update sidebar/dashboard to link to this flow

## Technical Details

- **API proxy pattern**: Frontend never calls Google directly; edge function proxies all requests to keep the API key server-side
- **Debounce**: 300ms on keystroke to avoid excessive API calls
- **State management**: React state for now (per spec: "store GBP data to session")
- **Google Places API (New)**: Uses the newer `places.googleapis.com` endpoints

