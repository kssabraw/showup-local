# PRD — Client Dashboard (Brand Voice + ICP) (Portable)

> **Purpose:** Re-create the per-client dashboard from ShowUP Local where a user
> views and **edits** a client's **Brand Voice** and **ICP / Differentiators**,
> and triggers the analyses that generate them. This is the UI layer that sits on
> top of the Brand Voice Engine and ICP Creator (see `BRAND_VOICE_PRD.md` and
> `ICP_CREATOR_PRD.md`).
>
> Reference implementation: a single React + TypeScript component
> (`ClientDashboard.tsx`, ported from `LocationDetailView.tsx`). The port
> decouples the UI from any specific backend via an injected **API adapter** —
> wire it to your own persistence + analysis endpoints.

---

## 1. Overview

A tabbed detail screen for one client/business with three tabs:

1. **Overview** — read-only business facts (address, phone, website, hours,
   description, rating) + an optional "Update from source" (e.g. Google Business
   Profile) refresh button.
2. **ICP & Differentiators** — view/edit the detected Ideal Customer Profile
   (1–3 segments) and the differentiators list; trigger/re-run ICP analysis.
3. **Brand Voice** — view/edit the **current** voice, review/**accept or decline**
   the **recommended** voice, see the **writer execution guide** (when accepted);
   trigger/re-scan brand voice.

Each editable section has **view mode** and **inline edit mode**, an explicit
**Save/Cancel**, and a shared **sticky save bar** at the bottom whenever any
section is being edited. Tabs show a small **green dot** when data exists.

---

## 2. Dependencies & assumptions

- **React 18 + TypeScript.**
- **Tailwind CSS** for styling (classes use shadcn/ui design tokens:
  `bg-card`, `text-muted-foreground`, `border-border`, `text-accent`, etc. —
  remap to your tokens or plain colors if you don't use shadcn).
- **`lucide-react`** for icons.
- **No data library required** — all backend access goes through an injected
  `ClientDashboardApi` (§5). The reference wires it to Supabase + a FastAPI NLP
  service, but the component itself is backend-agnostic.

---

## 3. Data model (TypeScript)

```ts
interface BrandVoiceProfile {
  personality?: string[];
  tone?: string;
  writing_style?: Record<string, string>;       // sentence_length, person, jargon_level, formality
  vocabulary?: { use?: string[]; avoid?: string[] };
  messaging_themes?: string[];
  sample_phrases?: string[];
  content_generation_instructions?: string;
}

interface BrandVoice {
  current_voice?: BrandVoiceProfile | null;
  recommended_voice?: BrandVoiceProfile | null;
  recommended_accepted?: boolean | null;         // null = undecided, true = accepted, false = declined
  writer_execution_guide?: Record<string, unknown> | null;
}

interface IcpSegment {
  label: string;
  confidence: number;                            // 0–1
  primary: boolean;
  demographics: { description: string; situation: string };
  psychographics: {
    trigger: string; fears: string[]; motivations: string[]; buying_behavior: string;
  };
  messaging: { tone: string; hooks: string[]; trust_signals: string[] };
}

interface DetectedIcp { segments: IcpSegment[]; reasoning?: string }

interface Differentiator { claim: string; mechanism: string; type: string }

interface ClientProfile {
  id: string;
  business_name: string;
  gbp_category: string;
  gbp_categories?: string[];
  website?: string | null;
  phone?: string | null;
  address?: string;
  description?: string | null;
  hours?: string[] | null;
  logo?: string | null;
  photo?: string | null;
  rating?: number | null;
  review_count?: number | null;
  maps_uri?: string | null;
  existing_pages?: unknown[];
  analysis_status?: string;                       // "pending" | "running" | "complete" | "partial" | "failed"
  detected_icp?: DetectedIcp | null;
  differentiators?: Differentiator[];
  brand_voice?: BrandVoice | null;
}
```

> **Legacy format support:** the Brand Voice tab must handle both the new shape
> (`{ current_voice, recommended_voice, ... }`) and a legacy "flat" shape where
> the `brand_voice` object *is* the voice profile. Detect via
> `('recommended_voice' in bv || 'current_voice' in bv)`; if neither key is
> present, treat the whole object as the current voice.

---

## 4. Functional requirements

### 4.1 Tabs & shell
- Header: logo/photo (fallback icon), business name, primary category, category
  chips, star rating + review count.
- Three tab buttons; active tab styled distinctly; green dot when:
  - ICP tab: `detected_icp.segments.length > 0 || differentiators.length > 0`
  - Brand Voice tab: `brand_voice != null`
- "← Back" affordance.

### 4.2 Overview tab
- Show address, phone, website (external link), maps link, description, hours.
- **Update** button → calls `api.refreshFromSource(client)` (optional); on success
  merge returned fields and persist; show transient success/error inline (auto-clears).

### 4.3 ICP & Differentiators tab
**ICP card**
- **View mode:** reasoning text, then each segment card showing label (+ primary
  check), confidence %, "Who They Are" (demographics), Psychographics (trigger,
  fears list, motivations list, buying behavior), Messaging (tone, hooks list,
  trust signals list).
- **Actions:** `Edit`; and `Scan Website` / `Detect from Category` / `Re-run`
  (label depends on whether ICP exists and whether a website is on file) →
  `api.runIcpAnalysis(client)`; `Cancel` while running (abortable).
- **Edit mode:** editable reasoning; per-segment editors for all fields; list
  fields (fears, motivations, hooks, trust_signals) support add/remove items;
  primary checkbox; delete segment; **Add Segment** (uses a blank-segment
  template). Save → `api.saveClient(id, { detected_icp })`.
- **Empty state:** prompt to run analysis (copy varies on `analysis_status` and
  website presence).

**Differentiators card**
- Shows `{n}/3 minimum required before content generation` helper.
- **View:** each differentiator = claim + mechanism + a `type` chip.
- **Edit:** inline edit claim/mechanism, remove, **+ Add differentiator**. Save →
  `api.saveClient(id, { differentiators })`.
- **Empty state:** prompt + "Add differentiator manually".

### 4.4 Brand Voice tab
**Current Voice card**
- Subtitle "How your site sounds today".
- **Actions:** `Edit`; `Scan Website` / `Generate from Category` / `Re-scan`
  (label depends on existence + website) → `api.scanBrandVoice(client)`;
  `Cancel` while scanning.
- **View:** renders a voice profile — personality chips, tone, writing-style grid,
  vocabulary use/avoid, messaging themes, sample phrases (italic, quoted),
  content generation instructions.
- **Edit:** editors for personality (add/remove), tone, each writing_style key,
  vocabulary use/avoid (add/remove), messaging themes (add/remove), sample
  phrases (add/remove), content generation instructions. Save → persists the
  edited profile back into `current_voice` (preserving the rest of the
  `brand_voice` blob) via `api.saveClient(id, { brand_voice })`.
- **Empty/edge:** when there's no website, `current_voice` may be null even though
  `brand_voice` exists → show "current voice could not be analyzed; see
  Recommended below."

**Recommended Voice card** (only when `recommended_voice` exists and not declined)
- Subtitle reflects state ("How your brand voice could be elevated" /
  "Accepted — used for content generation").
- When `recommended_accepted === null`: **Accept** / **Decline** buttons.
- When `accepted === true`: highlight as active; allow **Decline**; show the
  **Writer Execution Guide** (render strings, arrays, and nested objects;
  relabel `ai_writing_rules`→"Content Consistency Guidelines",
  `seo_aeo_instructions`→"Search Visibility Guidelines").
- When `accepted === false`: collapse to a thin "declined — Review again" row that
  resets status to `null`.
- Accept/Decline → `api.saveClient(id, { brand_voice: { ...bv, recommended_accepted } })`.

### 4.5 Sticky save bar
- Fixed bottom bar appears whenever ICP, differentiators, or brand voice is in
  edit mode. Shows which section is being edited; Cancel exits all edit modes;
  Save dispatches to the active section's save handler; disabled while saving.

---

## 5. API adapter (the integration seam)

The component takes an `api` prop implementing:

```ts
interface ClientDashboardApi {
  /** Run ICP + differentiator analysis (POST /analyze-business equivalent). */
  runIcpAnalysis(client: ClientProfile): Promise<{
    existing_pages: unknown[];
    detected_icp: DetectedIcp | null;
    differentiators: Differentiator[];
    analysis_status: string;
  }>;

  /** Run brand voice analysis (POST /analyze-brand-voice equivalent). */
  scanBrandVoice(client: ClientProfile): Promise<{ brand_voice: BrandVoice }>;

  /** Persist a partial update to the client record. */
  saveClient(id: string, patch: Partial<ClientProfile>): Promise<void>;

  /** OPTIONAL — refresh business facts from the source of truth (e.g. GBP). */
  refreshFromSource?(client: ClientProfile): Promise<Partial<ClientProfile>>;
}
```

Component props:
```ts
interface ClientDashboardProps {
  client: ClientProfile;
  api: ClientDashboardApi;
  onBack?: () => void;
  onChange?: (updated: ClientProfile) => void;   // notified after each persisted change
  onError?: (title: string, message: string) => void;  // toast hook (optional)
}
```

> The reference app implements `runIcpAnalysis`/`scanBrandVoice` as calls to the
> Railway FastAPI service and `saveClient`/`refreshFromSource` against Supabase.
> Any backend works as long as the adapter returns the shapes above.

---

## 6. Behavior details / gotchas

- **Optimistic local state:** the component holds a local copy of the client and
  updates it after each successful `saveClient`/analysis, then calls `onChange`.
- **Abortable analyses:** "Scan"/"Re-run" use an `AbortController`; Cancel aborts;
  ignore `AbortError`.
- **Status transitions:** set `analysis_status: "running"` before ICP analysis,
  then to the returned status (`complete`/`partial`) or `failed` on error.
- **No-website paths:** both analyses work without a website (category inference);
  button labels switch to "Detect/Generate from Category".
- **Deep-clone before editing** list/segment drafts (`JSON.parse(JSON.stringify())`)
  so edits don't mutate the persisted object until Save.
- **Brand voice save** must merge the edited profile back into `current_voice`
  without dropping `recommended_voice`, `recommended_accepted`, or
  `writer_execution_guide`.

---

## 7. Acceptance criteria

- [ ] Three tabs render; green dots reflect data presence.
- [ ] Overview shows business facts; optional refresh merges + persists.
- [ ] ICP view renders all segment fields; edit mode supports full CRUD on
      segments and their list fields; Save persists `detected_icp`.
- [ ] Differentiators view/edit/add/remove; Save persists `differentiators`;
      `n/3` helper shown.
- [ ] Brand voice current-voice view/edit; Save merges into `current_voice`.
- [ ] Recommended voice Accept/Decline persists `recommended_accepted`; writer
      guide shows only when accepted; declined collapses with "Review again".
- [ ] Both new and legacy brand_voice shapes render correctly.
- [ ] Scan/Re-run/Re-scan trigger the adapter, are abortable, and update status.
- [ ] Sticky save bar appears during any edit and dispatches correctly.
- [ ] Component compiles with only `react` + `lucide-react` (+ Tailwind) — no
      hard dependency on a specific backend.

---

## 8. Build order (suggested)
1. Types (§3) + props/adapter interface (§5).
2. Shell: header + tabs + green-dot logic.
3. Overview tab + optional refresh.
4. ICP card: view mode → edit mode (segments + list CRUD) → save.
5. Differentiators card: view/edit/add/remove → save.
6. Brand Voice: current-voice view → edit → save (merge); recommended
   accept/decline; writer guide render; legacy-shape handling.
7. Sticky save bar.
8. Wire the adapter to your backend (analysis endpoints + persistence).
```
