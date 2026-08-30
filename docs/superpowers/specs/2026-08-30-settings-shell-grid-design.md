# Settings Page — Full-Width Structured Shell + Grid Redesign

Date: 2026-08-30
Status: Approved design (brainstorming, option A)
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
- Adopted by Settings, MCP, Skills, Plugins, Subagents, Statistics in
  `src/app/page.tsx` (mechanical swap of their self-owning wrapper; content and
  Back-to-chat behavior unchanged).

### 2. Settings layout (the structured grid)

`SettingsView` renders inside `PageView`'s frame as a **fractional full-width
grid** (Tabs keep ownership of tab state):

- Default: `grid-cols-[minmax(0,2fr)_minmax(0,1fr)]` — primary config column +
  secondary summary/About column.
- Collapses to a single column at `lg`/mobile.
- The `About`/summary content lives in the secondary column (persistent beside
  the active tab), giving the right-hand rail a real purpose rather than
  mirroring a tab.
- Full-width `Alert` (danger banner) above the grid, unchanged.
- `min-w-0` on grid children to prevent long-name overflow.

### 3. Tab navigation: left "Setup" rail

- Desktop (`lg+`): the six tabs render as a **sticky left rail** (`~w-56`) of
  tab buttons, active state via `data-[state=active]` styling. Keeps
  Tabs/Radix architecture (still a `Tabs` component; the rail is the
  `TabsList` layout). When the summary column exists, its content is
  independent of the rail.
- Mobile (`<lg`): the existing segmented `TabsList` bar (`lg:hidden`), or a
  `Select`/`ScrollArea` fallback if the six segments overflow.
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

### 5. Components & tokens

- Tailwind v4 setup is already correct (two-stage `@theme inline` + `:root`
  /`.dark` oklch roles, `--radius-*` derived). Build on it, roles only, no raw
  hex, no arbitrary spacing.
- shadcn primitives already installed and reused: `Card`, `Tabs`, `Button`,
  `Switch`, `Select`, `Input`, `Dialog`, `Alert`, `Badge`, `Separator`,
  `ScrollArea`, `Tooltip`. Add `Label` (+ verify `InputGroup` covers
  prefix/suffix "breadcrumb" inputs) via the shadcn CLI (npx, matches repo
  style). No hand-rolled controls/modals.

### 6. Responsive behavior

- Grid: 2-col → 1-col below `lg`.
- Rail → segmented bar on mobile.
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
- `src/components/ui/label.tsx` (+ verify/adjust `input-group.tsx`) — new
  primitives.
- `globals.css` — only if a new token role is needed (prefer none).

## Testing

- Visual/manual: each tab at desktop + mobile, rail→segmented, danger banner,
  responsive grid collapse, long-name overflow.
- Existing vitest suites must stay green (settings/mcp/etc. shape tests);
  add/extend a component test if the `PageView` + rail behavior is readily
  assertable (e.g. active-tab switching, container tokens).
- Keyboard nav + contrast spot-check per the ui-master checklist.
