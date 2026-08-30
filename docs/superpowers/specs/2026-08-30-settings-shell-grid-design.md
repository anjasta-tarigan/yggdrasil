# Settings Page — Full-Width Structured Shell + Grid Redesign

Date: 2026-08-30
Status: Final design (approved via brainstorming, option A; review revisions applied)
Skill guidance: ui-master (Tailwind v4 + shadcn/ui production floor)

## Problem

The Settings page (`src/components/settings-view.tsx`, 1427 lines) reads as a
long vertical scroll of stacked cards inside a narrow `max-w-3xl` column. Two
distinct defects:

1. **Loose content-area contract.** The shell's content area
   (`src/app/page.tsx:163`) is a bare `<div className="min-h-0 flex-1">`.
   Every view re-implements its own wrapper — `mx-auto w-full max-w-X px-4
   py-6` plus a hand-rolled "Back to chat" button — with inconsistent widths
   (`max-w-3xl` Settings/MCP/Plugins/Skills, `max-w-4xl` Subagents, `max-w-5xl`
   Statistics).
2. **Unstructured settings.** Six tabs (General, AI Provider, Embedding
   Provider, Database, Tools, About), each a `space-y-4` pile of cards with no
   explicit region layout.

Goal: the page fills the content-area with an explicit structured grid — full
width *and* structured, via explicit columns, not a width cap.

## Approach (option A)

A shared page layout owns the full-width grid frame + scroll + header (fixing
the loose contract for every view), while the Settings page is decomposed so
its structure comes from explicit grid regions. The substantive redesign is
Settings itself; the other views' *content* is left intact — only their
container/header moves into the shared layout (mechanical).

## Design

### 1. Shared page layout

New component, e.g. `src/components/app-shell/page-view.tsx`
(`PageView`), owning the content-area filling + scroll + header + back button:

- Renders the full-width frame the other views currently self-own, with a
  **consistent container token** (padding + inner gutter) instead of per-page
  `max-w`/`px` values.
- Header: page title + "Back to chat" button + optional topline actions.
- Root `h-full overflow-y-auto` (matches current `h-full overflow-y-auto` in
  `settings-view.tsx:620`); content scrolls, header stays reachable.
- Adopted by **every** shell-backed view in `src/app/page.tsx`: Settings, MCP,
  Skills, Plugins, Subagents, Statistics, **and Cron Jobs** (mechanical swap of
  their self-owning wrapper; content and Back-to-chat behavior unchanged). Cron
  Jobs was the one view absent from the earlier narrative enumeration — it is
  in the mechanical-swap set and must not be lost during implementation.

### 2. Settings layout (the structured grid)

`SettingsView` renders inside `PageView`'s frame as a **fractional full-width
grid** (Tabs keep ownership of tab state):

- Default: `grid-cols-[minmax(0,2fr)_minmax(0,1fr)]` — primary config column +
  secondary summary column. Full-width `Alert` (danger banner) above the grid,
  unchanged. `min-w-0` on grid children to prevent long-name overflow.
- **Secondary-column policy (resolved):** the right column is **tab-reactive,
  not static**. Each tab drives a per-tab summary panel in the secondary
  column — General shows a settings summary; AI Provider shows the
  provider-count/test-status overview; Embedding shows the active model and
  readiness; Database shows engine/storage/feature stats; Tools shows which
  search/skill tools are enabled; About shows version + links. This gives the
  rail real, per-tab purpose rather than a static mirror. A small
  per-tab summary component (`SettingsSummary`) switches on the active tab and
  is *not* persisted state — it derives from the same settings data the active
  tab already loads, so no new data plumbing; re-render is cheap.
- Below `lg` (single column) the secondary summary collapses into the top of
  the active tab's scroll region, so no information is lost on mobile.

### 3. Tab navigation: left "Setup" rail

- Desktop (`lg+`): the six tabs render as a **sticky left rail** (`~w-56`) of
  tab buttons, active state via `data-[state=active]` styling. Keeps
  Tabs/Radix architecture (still a `Tabs` component; the rail is the
  `TabsList` layout).
- Mobile (`<lg`): the six-tab segmented bar **will overflow at 360px**
  ("Embedding Provider" alone nearly fills it), so the mobile component tree is
  resolved now, not as an if-needed fallback: the rail collapses to a
  `Select`-driven tab switcher (a labeled `Select` bound to the tab value;
  `value`/`onValueChange` map to `Tabs`). This deliberately replaces the
  existing footer-style segmented bar rather than subjecting it to a
  conditional overflow check. Each tab remains a real `TabsContent` in the
  same `Tabs` root for both orientations (single source of tab state).
- Each tab is its own scroll container so switching tabs starts at top (no
  mid-scroll carryover).

### 4. Each tab: precise two-column labeled rows

`SettingsView` is decomposed into per-tab sections; each config item becomes a
**labeled row** instead of a card pile:

- Row: `grid grid-cols-[minmax(0,1fr)_minmax(0,auto)]`, stacking at `sm`.
- Left cell: label + description (`text-muted-foreground`, wrap with
  `max-w` for readability).
- Right cell: the control (`Switch`, `Input`, `Select`, `Button`, …).
- Rows separated by `Separator`; semantically connected rows grouped in a
  `Card`. Keep the existing providers-list cards and add/edit `Dialog`s.
- **Row-height stability (resolved):** controls vary (`Switch` vs `Select` vs
  `Button`), so each labeled row sets a fixed control-row height
  (`h-10`/`h-9` per control) and the label cell is vertically centered,
  preventing jitter where labels of differing wrap-length shift control
  alignment down the list. Right-cell controls align to a consistent
  vertical center across a `Card`'s rows.

### 5. Components & tokens

- Tailwind v4 setup is already correct (two-stage `@theme inline` + `:root`
  /`.dark` oklch roles, `--radius-*` derived). Build on it, roles only, no raw
  hex, no arbitrary spacing.
- shadcn primitives already installed and reused: `Card`, `Tabs`, `Button`,
  `Switch`, `Select`, `Input`, `Dialog`, `Alert`, `Badge`, `Separator`,
  `ScrollArea`, `Tooltip`. Add `Label` via the shadcn CLI (npx, matches repo
  style).
- **`InputGroup` fallback plan (resolved):** `src/components/ui/input-group.tsx`
  is a repo-owned shadcn-style primitive already present. If its current API
  does **not** cover prefix/suffix "breadcrumb" inputs (e.g. a base-URL field
  with a leading `/` segment), the plan is to **extend `input-group.tsx`** to
  support optional `prefix`/`suffix` slots — never a one-off inline
  composition in `settings-view.tsx`, honoring the "no hand-rolled controls"
  constraint from the same section.

### 6. Responsive behavior

- **Staggered breakpoints (resolved — avoids a coincident double-collapse).**
  The rail and the grid flip at *different* widths so one step of layout change
  happens at a time instead of two systems collapsing simultaneously at `lg`:
  - `md` — grid goes 2-col → 1-col (the first, larger structural change).
  - `lg` — rail appears / `Select` switcher gives way to the `lg+` rail.
  This reads as two distinct, deliberate steps (grid narrows, then the nav
  moves to the rail) rather than one jarring two-way flip.
- Labeled rows stack at `sm`.
- Dialogs use existing responsive widths; forms remain usable at 360px.

### 7. Accessibility & performance floor (ui-master)

- `focus-visible` on every interactive control (inherited from shadcn).
- WCAG AA contrast via token roles.
- Keyboard-reachable tab list + dialogs; active tab uses color+text, not
  motion-only.
- Loading (`Spinner`), error, and empty states per tab (provider add dialog,
  database stats, tools).
- `prefers-reduced-motion` respected.
- No layout shift; `min-w-0` prevents overflow. Render at real breakpoints
  (360px → desktop), not resized-browser eyeballing.

## Scope / non-goals

- In scope: shared `PageView` layout; Settings full-width grid; tab rail;
  labeled-row decomposition of Settings; mechanical container swap for other
  views; `Label`/`InputGroup` additions.
- Out of scope (unchanged): other views' inner content; the shell/Sidebar
  itself; any provider/tool logic; per-view `max-w` cleanup beyond the
  container/header move.

## Files touched

- `src/components/app-shell/page-view.tsx` (new) — shared full-width frame.
- `src/components/settings-view.tsx` — decompose into rail + grid + labeled
  rows; drop its self-owning wrapper.
- `src/components/{mcp,skills,plugins,subagents,statistics,cron-jobs}-view.tsx`
  — mechanical swap to `PageView` (container/header only).
- `src/app/page.tsx` — render views inside `PageView`; pass title.
- `src/components/ui/label.tsx` (+ extend `input-group.tsx` for prefix/suffix if
  its current API lacks them) — new/updated primitives.
- `globals.css` — only if a new token role is needed (prefer none).

## Testing

- **Component tests (committed, not deferred):** add/extend tests asserting the
  rail/`Select`-switcher tab behavior (active-tab switching and persistence
  across both orientations), the `PageView` container tokens, and the
  per-tab summary derivation. Because this is a UI-heavy refactor with no
  logic changes, a `Tabs`/`Select`-behavior component test (with
  `@testing-library`) is the reliable regression net; manual spot-checks alone
  would miss state/overflow regressions on re-runs.
- **Visual/manual:** each tab at desktop + mobile; rail→Select switcher; danger
  banner; staggered `md`/`lg` collapse; long-name overflow; per-tab summary
  panel content.
- Existing vitest suites (settings/mcp/etc. shape tests) must stay green.
- Accessibility spot-check per §7, with keyboard nav verified at both
  breakpoints.
