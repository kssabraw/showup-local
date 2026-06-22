# PRD — Bulk Silo Page Creation (Implementation Reference)

**Status:** Build-ready spec for replication by a coding agent (Claude Code)
**Owner:** Platform
**Last updated:** 2026-06-22
**Source feature:** ShowUP Local "Related Pages" panel → bulk create (`NewContentView`)
**Target stack:** React/Vite + TypeScript frontend · Supabase · streaming `/generate-page` writer
**Companion doc:** `docs/PRD_silo_pages.md` (silo research — produces the `missing` items this feature generates)

---

## 0. How to use this document (read first)

This spec covers the **bulk creation layer** that sits on top of two existing pieces:
1. the **silo research** feature (`docs/PRD_silo_pages.md`) — produces the list of
   `missing` keywords the user selects; and
2. the **single-page writer** (`POST /generate-page`, streaming) — already built in the
   target app.

Bulk creation is **pure frontend orchestration**: select N missing keywords → run the
existing single-page generator **sequentially** for each → auto-save each result →
track progress, handle failures with credit refunds, allow cancel. There is **no new
backend endpoint**.

Build order:
1. **§5** prerequisites (writer endpoint + research panel must exist).
2. **§7.1–7.2** selection state + the related-pages panel checkboxes.
3. **§7.3** the per-page `createAndSavePage` worker (generate → save → score → refund).
4. **§7.4** the `handleBulkCreate` sequential queue + **§7.5** cancellation.
5. **§8** progress UI.
6. **§9** credits/refund model · **§10** cross-cutting · **§11** test plan.

> ⚠️ **VERBATIM** blocks are copied from the reference implementation — reproduce exactly
> (adjust imports only). **ADAPT** blocks are illustrative.

**Scope boundary:** the writer (`/generate-page`, its prompts, scoring, the
`generated_pages` schema) is assumed to exist. This doc specifies how bulk creation
*drives* and *persists* it, not how generation works internally.

---

## 1. Purpose, Goals, Non-Goals

**Purpose:** Let a user take the `missing` pages surfaced by silo research and generate +
save all of them in one action, with live progress and graceful failure handling.

**Goals**
- Multi-select missing silo keywords (incl. "select all missing").
- Generate each selected page using the existing single-page writer, unchanged.
- Auto-save every successful page to `generated_pages` (no manual save step).
- Live progress: overall N/total, per-page %, elapsed + ETA, done/failed counts.
- Robust per-item failure isolation + automatic credit refund on failure.
- Cancellable mid-run without corrupting state.

**Non-Goals**
- No new backend/bulk endpoint — orchestration is client-side.
- No parallel generation (intentionally sequential — see §6).
- No change to the writer, scoring, or schema.
- No server-side job queue / background processing (runs in the open tab).

---

## 2. Where bulk creation lives

The selection UI and the bulk runner both live in the **content view**
(`NewContentView.tsx`), reusing the **Related Pages panel** (the same `relatedPages`
results described in the silo research PRD). Missing items get a checkbox; selected items
form the bulk queue. Unlike the standalone `PlanningView` (whose "Create" navigates to the
writer one page at a time), this panel generates in-place and stays on the page.

```
Related Pages panel (missing items)
   │  ☑ select keywords → selectedForCreate: Set<string>
   ▼
handleBulkCreate()                      ── sequential queue ──┐
   │  for kw of queue:                                        │
   │     createAndSavePage(kw)                                │
   │        ├─ nlpStreamDirect("/generate-page", payload)     │  (existing writer)
   │        ├─ on SSE "done" → insert generated_pages         │
   │        ├─ insert token_usage                             │
   │        ├─ (optional) score if writer returned none       │
   │        └─ on error/abort/no-done → refund 2 credits      │
   ▼                                                          │
progress state ◀──────────────────────────────────────────────┘
   bulkProgress {current,total,currentKw} · bulkPageProgress {progress,step}
   bulkElapsed (ETA) · bulkDone · bulkFailed
```

---

## 3. Data flow & contracts

### 3.1 Streaming event types (`nlp-types.ts`) — **VERBATIM**
The writer streams Server-Sent Events; bulk creation consumes them per page.
```ts
export interface StreamProgressEvent {
  progress?: number;
  message?: string;
  step?: never;
  result?: never;
}
export interface StreamErrorEvent {
  step: "error";
  message: string;
  progress?: number;
}
export interface StreamDoneEvent<T> {
  step: "done";
  result: T;
  progress?: number;
  message?: string;
}
export type StreamEvent<T> = StreamProgressEvent | StreamErrorEvent | StreamDoneEvent<T>;
```

### 3.2 Writer result shape (`GeneratePageResult`) — **VERBATIM**
```ts
export interface GeneratePageResult {
  content_html: string;
  schema_json: string;
  page_title: string;
  composite_score?: number | null;
  token_usage: TokenUsage;
  cost_breakdown: CostBreakdown;
  serp_analysis?: AnalysisResult;
  content_gaps?: ContentGap[];
}
```

### 3.3 `generated_pages` insert shape
Each successful page is inserted with at least:
`business_id, keyword, location, mode:"generate", page_title, content_html, schema_json,
content_gaps, composite_score, scored_at`. (See the writer's schema for the full column
list; bulk creation writes the same columns the single-page save path writes.)

---

## 4. Streaming transport — **VERBATIM**

Bulk creation calls the writer through `nlpStreamDirect`, which streams SSE **directly from
Railway** (bypassing the Supabase edge function's 150s timeout — generation can take
minutes). Each newline-delimited `data: {...}` line is parsed into a `StreamEvent`.

```ts
/**
 * Like nlpStream but calls Railway directly — bypasses the Supabase edge
 * function and its 150-second timeout limit. Used for long-running endpoints
 * (/generate-page, /reoptimize-page). Railway verifies the JWT and handles
 * credit deduction itself.
 */
export async function* nlpStreamDirect<T>(
  endpoint: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent<T>> {
  const authHeader = await getAuthHeader();
  const res = await fetch(`${NLP_SERVICE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throwIfInsufficientCredits(res, d);
    throw new Error((d as { detail?: string; error?: string }).detail
      || (d as { detail?: string; error?: string }).error
      || `NLP error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        yield JSON.parse(line.slice(6)) as StreamEvent<T>;
      } catch {
        // skip malformed lines
      }
    }
  }
}
```

> `throwIfInsufficientCredits` maps HTTP 402 → `InsufficientCreditsError` (with
> `credits_required`) and 429 → `RankabilityLimitError`. Reuse the target app's
> equivalent guard.

---

## 5. Prerequisites

| Dependency | Why |
|---|---|
| Streaming `POST /generate-page` writer | Generates one page; emits SSE progress + a final `done` event with `GeneratePageResult`. |
| `nlpStreamDirect` + `StreamEvent`/`GeneratePageResult` types (§3–§4) | Transport. |
| Related Pages panel + `relatedPages()` results | Source of `missing` keywords (see silo research PRD). |
| Supabase `generated_pages` table | Persistence. |
| Supabase RPCs `refund_failed_generation` (and the writer's credit-deduction path) | Credit safety (§9). |
| Optional `nlp.scorePage` + `token_usage` table | Backfill score + usage logging. |
| Selected business profile (`business_name, gbp_category, address, phone, website, hours, description, differentiators, brand_voice, detected_icp, reviews`) | Generation payload. |

---

## 6. Why sequential (design decision)

Bulk creation runs **one page at a time** (`await` each before the next), not in parallel:
- Each generation is a long SSE stream with an internal auto-retry/reoptimize loop — many
  concurrent streams would hammer the writer + Claude rate limits.
- Sequential gives a clean, truthful progress model (one active page, accurate ETA from
  rolling average) and bounded memory.
- Failures are isolated and individually refundable without racing shared state.

The trade-off (slower wall-clock for large batches) is acceptable and is surfaced to the
user via the ETA. If you later parallelize, cap concurrency (e.g. 2–3) and rework the
progress model accordingly.

---

## 7. Frontend Implementation

### 7.1 Selection + progress state — **VERBATIM**
```ts
const [relatedPages, setRelatedPages] = useState<Array<{ keyword: string; group: string; status: string; url?: string; composite_score?: number }> | null>(null);
const [relatedLoading, setRelatedLoading] = useState(false);
const [selectedForCreate, setSelectedForCreate] = useState<Set<string>>(new Set());

const [bulkCreating, setBulkCreating] = useState(false);
const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; currentKw: string } | null>(null);
const [bulkPageProgress, setBulkPageProgress] = useState<{ progress: number; step: string }>({ progress: 0, step: "" });
const [bulkElapsed, setBulkElapsed] = useState(0);
const bulkElapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
const [bulkDone, setBulkDone] = useState(0);
const [bulkFailed, setBulkFailed] = useState(0);

const bulkCancelledRef = useRef(false);
const abortRef = useRef<AbortController | null>(null);
```

### 7.2 Selection UI (Related Pages panel) — **VERBATIM (key parts)**

Only `missing` items get a checkbox; `found` items show a "Score →" action instead.
"Select all missing" toggles the whole set.
```tsx
const missingItems = (relatedPages ?? []).filter(p => p.status === "missing");
const allMissingSelected = missingItems.length > 0 && missingItems.every(p => selectedForCreate.has(p.keyword));

// header toggle:
<button className="text-xs text-accent underline"
  onClick={() => setSelectedForCreate(allMissingSelected ? new Set() : new Set(missingItems.map(p => p.keyword)))}>
  {allMissingSelected ? "Deselect all" : "Select all missing"}
</button>

// per missing item:
<input type="checkbox" className="shrink-0 accent-accent w-4 h-4 cursor-pointer"
  checked={selectedForCreate.has(item.keyword)}
  onChange={e => setSelectedForCreate(prev => {
    const next = new Set(prev);
    e.target.checked ? next.add(item.keyword) : next.delete(item.keyword);
    return next;
  })} />

// footer CTA (when selectedForCreate.size > 0 and not already running):
<Button className="w-full ..." onClick={handleBulkCreate}>
  <Sparkles className="w-4 h-4 mr-2" />
  Create {selectedForCreate.size} Selected Page{selectedForCreate.size > 1 ? "s" : ""}
</Button>
```

### 7.3 Per-page worker — `createAndSavePage` — **VERBATIM**

Generates one page, consumes the SSE stream, saves on `done`, backfills score + token
usage, and **refunds 2 credits on any failure path** (error event, save error, stream
ended without `done`, or thrown exception). Returns `true`/`false`.

```ts
// Creates + auto-saves a page for the given keyword without navigating away (bulk flow)
const createAndSavePage = async (kw: string, signal?: AbortSignal, onProgress?: (progress: number, step: string) => void): Promise<boolean> => {
  const b = businesses.find(b => b.id === selectedBusinessId);
  if (!b) return false;
  try {
    const stream = nlpStreamDirect<import("@/lib/nlp-types").GeneratePageResult>(
      "/generate-page",
      {
        keyword: kw.trim(),
        location: location.trim(),
        business_name: b.business_name,
        gbp_category: b.gbp_category,
        address: b.address,
        phone: b.phone,
        website: b.website,
        hours: b.hours ? JSON.stringify(b.hours) : undefined,
        gbp_description: b.description ?? undefined,
        differentiators: b.differentiators,
        brand_voice: b.brand_voice,
        detected_icp: b.detected_icp,
        reviews: Array.isArray(b.reviews) ? b.reviews : (b.reviews ? [b.reviews] : undefined),
      },
      signal,
    );
    for await (const evt of stream) {
      if (evt.progress !== undefined && onProgress) onProgress(evt.progress, evt.message ?? "");
      if ("step" in evt && evt.step === "error") {
        console.error(`[createAndSavePage] stream error event for "${kw}":`, evt);
        await supabase.rpc("refund_failed_generation", {
          p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
        });
        return false;
      }
      if ("step" in evt && evt.step === "done" && evt.result) {
        const genData = evt.result;
        const { error: saveError, data: savedRow } = await supabase
          .from("generated_pages")
          .insert({
            business_id: selectedBusinessId,
            keyword: kw.trim(),
            location: location.trim(),
            mode: "generate",
            page_title: genData.page_title ?? kw,
            content_html: genData.content_html,
            schema_json: genData.schema_json ?? null,
            content_gaps: genData.content_gaps ?? [],
            composite_score: genData.composite_score ?? null,
            scored_at: genData.composite_score != null ? new Date().toISOString() : null,
          })
          .select("id")
          .single();
        if (saveError) {
          console.error("bulk create: failed to save page for keyword", kw, saveError);
          await supabase.rpc("refund_failed_generation", {
            p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
          });
          return false;
        }
        // If Railway didn't return a score (transient failure), score now and update
        if (genData.composite_score == null && savedRow?.id) {
          try {
            const scoreResult = await nlp.scorePage({
              keyword: kw.trim(),
              location: location.trim(),
              page_content: genData.content_html,
              business_name: b.business_name,
              gbp_category: b.gbp_category,
              address: b.address,
              serp_analysis: genData.serp_analysis as any,
            });
            if (scoreResult?.composite_score != null) {
              await supabase.from("generated_pages").update({
                composite_score: scoreResult.composite_score,
                composite_status: scoreResult.composite_status,
                scored_at: new Date().toISOString(),
              }).eq("id", savedRow.id);
            }
          } catch {
            // Non-fatal — page saved without score
          }
        }
        await supabase.from("token_usage").insert({
          ...genData.token_usage,
          business_id: selectedBusinessId,
          keyword: kw,
        });
        return true;
      }
    }
    // Stream ended without a done event — refund
    console.error(`[createAndSavePage] stream ended without done event for "${kw}"`);
    await supabase.rpc("refund_failed_generation", {
      p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
    });
    return false;
  } catch (err) {
    console.error(`[createAndSavePage] caught exception for "${kw}":`, err);
    await supabase.rpc("refund_failed_generation", {
      p_amount: 2, p_endpoint: "/generate-page", p_business_id: selectedBusinessId,
    });
    return false;
  }
};
```

**Notes for the agent:**
- The single source of per-page progress is the writer's `progress`/`message` SSE events,
  surfaced through the `onProgress` callback.
- Credit **deduction** happens server-side inside `/generate-page` (Railway, via the
  direct-JWT path). The client only ever **refunds** (`refund_failed_generation`, amount
  `2`) when a started generation fails to produce a saved page — so the user is never
  charged for a page they didn't get.
- Score backfill is best-effort and non-fatal; a saved page without a score is acceptable.

### 7.4 The bulk runner — `handleBulkCreate` — **VERBATIM**

Sequential queue over the selected keywords. Maintains overall + per-page progress, a 1s
elapsed timer for ETA, and done/failed tallies. Breaks early if cancelled.

```ts
const handleBulkCreate = async () => {
  const queue = Array.from(selectedForCreate);
  if (!queue.length) return;
  abortRef.current = new AbortController();
  bulkCancelledRef.current = false;
  setBulkCreating(true);
  setBulkDone(0);
  setBulkElapsed(0);
  setBulkPageProgress({ progress: 0, step: "" });
  bulkElapsedRef.current = setInterval(() => setBulkElapsed(s => s + 1), 1000);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < queue.length; i++) {
    if (bulkCancelledRef.current) break;
    setBulkProgress({ current: i + 1, total: queue.length, currentKw: queue[i] });
    setBulkPageProgress({ progress: 0, step: "Starting…" });
    const ok = await createAndSavePage(queue[i], abortRef.current?.signal, (progress, step) => {
      setBulkPageProgress({ progress, step });
    });
    if (ok) done++; else failed++;
  }
  if (bulkElapsedRef.current) { clearInterval(bulkElapsedRef.current); bulkElapsedRef.current = null; }
  setBulkCreating(false);
  setBulkProgress(null);
  setBulkPageProgress({ progress: 0, step: "" });
  setBulkDone(done);
  setBulkFailed(failed);
  setSelectedForCreate(new Set());
  invalidateSavedPages();
};
```

### 7.5 Cancellation — **VERBATIM**

Sets the cancel flag (loop stops before the next page) **and** aborts the in-flight stream
(the current `nlpStreamDirect` fetch). Clears the elapsed timer.
```ts
const cancelBulk = () => {
  bulkCancelledRef.current = true;
  abortRef.current?.abort();
  abortRef.current = null;
  if (bulkElapsedRef.current) { clearInterval(bulkElapsedRef.current); bulkElapsedRef.current = null; }
};
```
> An aborted in-flight page throws inside `createAndSavePage`, which refunds its 2 credits
> in the `catch` — so cancelling never leaves the user charged for the interrupted page.

---

## 8. Progress UI — **VERBATIM (structure)**

Rendered in the panel footer while `bulkCreating`. Three layers of feedback:

1. **Header row** — spinner + current keyword + `current/total` + ETA derived from the
   rolling average of completed pages:
```tsx
<span className="text-xs text-muted-foreground shrink-0 ml-2">
  {bulkProgress.current} / {bulkProgress.total}
  {bulkProgress.current > 1 && bulkElapsed > 0 && (() => {
    const avgSec = bulkElapsed / (bulkProgress.current - 1);
    const remaining = Math.round(avgSec * (bulkProgress.total - bulkProgress.current + 1));
    return remaining > 0 ? ` · ~${remaining >= 60 ? `${Math.round(remaining / 60)}m` : `${remaining}s`} left` : null;
  })()}
</span>
```

2. **Overall segmented bar** — one segment per queued page (green = done, accent = active,
   muted = pending):
```tsx
<div className="flex gap-1">
  {Array.from({ length: bulkProgress.total }).map((_, idx) => (
    <div key={idx} className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
      idx < bulkProgress.current - 1 ? "bg-green-500"
      : idx === bulkProgress.current - 1 ? "bg-accent" : "bg-muted"}`} />
  ))}
</div>
```

3. **Per-page bar + step label** — driven by `bulkPageProgress`:
```tsx
<div className="w-full h-1 bg-muted rounded-full overflow-hidden">
  <div className="h-full bg-accent/70 rounded-full transition-all duration-500" style={{ width: `${bulkPageProgress.progress}%` }} />
</div>
{bulkPageProgress.step && <p className="text-xs text-muted-foreground truncate">{bulkPageProgress.step}</p>}

<button onClick={cancelBulk} className="...">Cancel</button>
```

4. **Completion summary** (after the run, when not `bulkCreating`):
```tsx
{bulkDone > 0 && <p className="text-xs text-green-600 font-medium">
  {bulkDone} page{bulkDone > 1 ? "s" : ""} created and saved — <button onClick={() => setContentTab("saved")} className="underline">view in Saved Pages</button>.
</p>}
{bulkFailed > 0 && <p className="text-xs text-destructive font-medium">
  {bulkFailed} page{bulkFailed > 1 ? "s" : ""} failed to save. Check console for details.
</p>}
```

---

## 9. Credit model

| Event | Action |
|---|---|
| `/generate-page` starts (per page) | Server (Railway) deducts the generation cost (2 credits) via the direct-JWT credit path. The client does **not** pre-deduct. |
| Page saved successfully | No client credit action. |
| Stream `error` event | Client refunds 2 (`refund_failed_generation`). |
| `generated_pages` insert fails | Client refunds 2. |
| Stream ends with no `done` | Client refunds 2. |
| Exception / abort (cancel) | Client refunds 2 (in `catch`). |

Net effect: the user is charged only for pages that are actually generated **and** saved.
`refund_failed_generation(p_amount, p_endpoint, p_business_id)` is the single refund RPC.

---

## 10. Cross-Cutting Concerns

| Concern | Spec |
|---|---|
| **Concurrency** | Strictly sequential (§6). One `AbortController` for the whole run; reused as each page's `signal`. |
| **Failure isolation** | Per-page try/catch; a failed page increments `failed` and the loop continues. One bad keyword never aborts the batch. |
| **Cancellation** | `bulkCancelledRef` stops the loop before the next page; `abortRef.abort()` kills the active stream; elapsed timer cleared. |
| **Timeouts** | Generation streams direct from Railway (`nlpStreamDirect`) to dodge the 150s edge-function limit — bulk runs of long pages are fine. |
| **Persistence** | Each page saved immediately on its own `done` — a crash/cancel keeps all pages completed so far. |
| **Post-run** | Clear `selectedForCreate`; `invalidateSavedPages()` so the Saved Pages tab reflects new rows. |
| **Cost visibility** | `token_usage` row inserted per successful page (`...genData.token_usage, business_id, keyword`). |
| **Tab lifetime** | Runs in the open tab; closing/navigating away stops the run (no background worker). Document this to users. |

---

## 11. Test Plan & Acceptance Criteria

### 11.1 Selection
- Only `missing` items are selectable; `found` items show "Score →", not a checkbox.
- "Select all missing" selects exactly the missing set; toggling again clears it.
- CTA label reflects count and pluralization; hidden when nothing is selected.

### 11.2 Happy path
- Select 3 missing → run → 3 rows appear in `generated_pages` with
  `mode="generate"`, correct `keyword`/`location`/`business_id`, `content_html` non-empty.
- Overall bar fills one segment per completed page; header shows `k/3` and an ETA after
  the first page completes.
- On finish: `bulkDone=3`, `bulkFailed=0`, selection cleared, Saved Pages shows the rows.
- A `token_usage` row exists per saved page.

### 11.3 Failure isolation + refunds
- Force a stream `error` on page 2 → page 2 counts as failed, pages 1 & 3 still save;
  `bulkFailed=1`, `bulkDone=2`; a refund of 2 credits is recorded for the failure.
- Force a `generated_pages` insert error → refund fired, page counted failed, batch continues.
- Stream closes with no `done` → refund fired, counted failed.

### 11.4 Cancellation
- Cancel mid-run → current stream aborts, loop stops, no further pages start; the
  interrupted page is refunded; already-saved pages remain; summary reflects partial counts.

### 11.5 Edge cases
- Empty selection → CTA hidden / no-op.
- No business selected → `createAndSavePage` returns false immediately (guard `if (!b)`).
- Writer returns `composite_score == null` → page still saves; score backfill attempted via
  `nlp.scorePage` and is non-fatal if it fails.
- Insufficient credits (HTTP 402 from the writer) → surfaced via `throwIfInsufficientCredits`;
  the page is counted failed (caught), batch continues for remaining pages.

---

## 12. Build Checklist

- [ ] §7.1 selection + progress state (`selectedForCreate`, `bulk*`, refs).
- [ ] §7.2 missing-item checkboxes + "select all missing" + CTA in the Related Pages panel.
- [ ] §3–§4 `StreamEvent`/`GeneratePageResult` types + `nlpStreamDirect` available.
- [ ] §7.3 `createAndSavePage` (generate → save → score backfill → token usage → refund on every failure path).
- [ ] §7.4 `handleBulkCreate` sequential queue with progress + elapsed timer + tallies.
- [ ] §7.5 `cancelBulk` (flag + abort + timer cleanup).
- [ ] §8 progress UI (header/ETA, segmented bar, per-page bar, summary).
- [ ] §9 `refund_failed_generation` RPC wired (amount 2); writer handles deduction.
- [ ] `invalidateSavedPages()` + selection reset on completion.
- [ ] §11 test plan green.

---

## 13. Reference File Map (source app)

| Concern | File · symbol |
|---|---|
| Selection + bulk state | `src/components/NewContentView.tsx` · `selectedForCreate`, `bulkProgress`, `bulkPageProgress`, `bulkElapsed`, `bulkDone`, `bulkFailed`, `bulkCancelledRef`, `abortRef` |
| Related panel + checkboxes | `src/components/NewContentView.tsx` · `relatedPagePanel` |
| Per-page worker | `src/components/NewContentView.tsx` · `createAndSavePage` |
| Bulk runner | `src/components/NewContentView.tsx` · `handleBulkCreate` |
| Cancellation | `src/components/NewContentView.tsx` · `cancelBulk` |
| Streaming transport | `src/lib/nlp-client.ts` · `nlpStreamDirect`, `nlp.generatePage`, `throwIfInsufficientCredits` |
| Stream + result types | `src/lib/nlp-types.ts` · `StreamEvent`, `GeneratePageResult` |
| Persistence | Supabase `generated_pages`, `token_usage`; RPC `refund_failed_generation` |
| Companion (research) | `docs/PRD_silo_pages.md` |
```
