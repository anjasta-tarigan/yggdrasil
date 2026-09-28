# Settings Modal Design Spec

Date: 2026-09-28
Status: Draft (pending review)

## Goal

Convert Settings from a full in-shell page (`view === "settings"` rendered
inside `PageView`) into a large centered modal overlay, visually similar to
Claude's web/desktop app: a two-pane layout with a vertical navigation list on
the left and the active section's content on the right, over a dimmed/blurred
overlay. Settings must open on top of whatever the user is doing (chat stays
visible behind the overlay and keeps streaming) — closing returns to exactly
where they were.

## Constraints (from CLAUDE.md / AGENTS.md / pasted task)

- `main` is production; `development` is integration branch. Branch from
  `development` for every change.
- pnpm is the package manager; run `pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint`.
- No new dependencies.
- No changes to: API routes, the settings data model, providers/embedding/
  reranker logic, other views (MCP/Skills/Plugins/Statistics/Cron/Subagents/
  Projects), or `PageView` (`src/components/app-shell/page-view.tsx`).
- Keep ALL existing state and handlers in `settings-view.tsx` (60 KB file). Do
  NOT rewrite business logic or split the file as part of this task.
- Existing tests render `<SettingsView onBack=… />` and click
  `getByRole("tab", { name: "Providers" })` — assertions on tab role must stay
  valid.
- Design tokens: `bg-popover`, `border-border`, `text-muted-foreground`, etc.
  No new colors or fonts.

## Non-goals

- The old spec `2026-08-30-settings-shell-grid-design.md` (full-width grid page)
  was NOT implemented — confirmed by reading it and the current code. We do NOT
  follow it.
- No redesign of tab internals (`tabs.tsx`, `tools-tab.tsx`, `persona-tab.tsx`,
  `reranker-tab.tsx`) unless layout visibly breaks in the modal width.

## Architecture

### Option (b): SettingsView renders DialogContent itself

`SettingsView` will own the `Dialog` + `DialogContent`, and `SettingsDialog`
will be a thin wrapper that controls `open`/`onOpenChange` and delegates
rendering to `SettingsView`. This is chosen over (a) because:

1. **`rebuildBusy` is local to `SettingsView`.** To block-close during a
   rebuild, `SettingsDialog` needs to read that state. If `SettingsDialog`
   owned the `Dialog`, it couldn't see it without lifting state up, which
   violates "keep all state in settings-view.tsx."
2. **Minimal diff to settings-view.tsx.** We replace the `<PageView>` shell
   around the existing Tabs/dialogs with a `DialogContent`-level layout, but
   keep every handler, every `useState`, and every sibling dialog in place.
3. The `onOpenChange`/`onClose` contract stays simple: one function
   (`requestClose`) routes through the rebuild guard and dirty guard.

### File map

- **Create** `src/components/settings/settings-dialog.tsx` — `SettingsDialog`
  wrapper + `SettingsDialogContent` presentational layout (nav + header +
  scrollable content).
- **Modify** `src/app/page.tsx` — remove `"settings"` from the `view` union,
  add `settingsOpen` state, render `<SettingsDialog>` always-mounted in the
  shell, pass `settingsOpen` to sidebar, drop the Header "Settings" title
  branch.
- **Modify** `src/components/settings-view.tsx` — drop `PageView`, drop
  `onBack` prop, render `SettingsDialogContent` as the root, keep all dialogs
  (Edit Provider, NimProviderDialog, ModelForm, Rebuild confirmation) as
  siblings.
- **Modify** `src/components/settings/shared.ts` — add `icon` field to
  `SETTINGS_TABS` (parallel to `value`/`label`).
- **Modify** `src/components/sidebar.tsx` — `settingsActive` now binds to
  `settingsOpen` instead of `view === "settings"` (visual-only;
  `aria-hidden` by Radix makes this inaccessible-context anyway).
- **Modify** `src/components/header.tsx` — no change needed; the "Settings"
  branch in `chatTitle` is removed in page.tsx.
- **Create** `src/components/settings/__tests__/settings-dialog.test.tsx`
- **Modify** `src/components/__tests__/settings-view.test.tsx` — update to
  new API.
- **Modify** `src/components/__tests__/embedding-tab.test.tsx` — update.
- **Modify** `src/components/__tests__/nim-settings.test.tsx` — update.
- **No change** to `src/components/app-shell/page-view.tsx`.

## Detailed Design

### 1. Modal shell (`settings-dialog.tsx`)

```tsx
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Render SettingsView inside DialogContent so it can read
          rebuildBusy / isDirty for close-guarding. SettingsView owns
          the DialogContent-level layout via SettingsDialogContent. */}
      <SettingsViewContent />
    </Dialog>
  );
}
```

Wait — that doesn't work either, because `SettingsView` needs to render
`DialogContent` but also be inside `Dialog`. The cleanest approach:

**`SettingsView` renders the entire `Dialog` itself.** `SettingsDialog`
becomes a thin re-export wrapper for the page.tsx side, or we inline it in
page.tsx. Decision: **inline `<SettingsView open={settingsOpen} onOpenChange={...} />`
in page.tsx, and `SettingsView` renders `<Dialog>` at its root.**

No intermediate `SettingsDialog` component is needed — `SettingsView`
becomes the dialog. This gives `SettingsView` access to all its own state
(`rebuildBusy`, `isDirty`) for close-guarding.

Signature change:
```ts
// before:  function SettingsView({ onBack }: { onBack: () => void })
// after:   function SettingsView({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void })
```

Wait — the task explicitly says "Create `src/components/settings/settings-dialog.tsx`
exporting `SettingsDialog({ open, onOpenChange })`." So we must create that
component. The resolution: `SettingsDialog` wraps `SettingsView` and passes
through `open`/`onOpenChange`. `SettingsView` accepts `open` + `onOpenChange`
instead of `onBack`. `SettingsView` renders `<Dialog open={open}>` at its
root, with `SettingsDialogContent` inside.

**Final structure:**

`settings-dialog.tsx`:
```tsx
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <SettingsView open={open} onOpenChange={onOpenChange} />
  );
}
```

`SettingsView`:
```tsx
export function SettingsView({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // ... all existing state & handlers unchanged ...

  // Close-guard: blocks Escape / overlay-click / X while rebuildBusy.
  // onOpenChange fires with `false` when any of those happens.
  const handleOpenChange = (next: boolean) => {
    if (!next && rebuildBusy) {
      // Block close — keep modal open, inner rebuild dialog still active.
      return;
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="settings-modal-content">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Application settings and configuration.
        </DialogDescription>
        {/* SettingsDialogContent: nav + header + scrollable content */}
        ...Tabs with vertical orientation...
        {/* sibling dialogs unchanged */}
      </DialogContent>
    </Dialog>
  );
}
```

**Why this is option (b) "SettingsView renders DialogContent itself":**
`SettingsView` renders `<Dialog>` + `<DialogContent>` and passes `open`/`onOpenChange`
through. `SettingsDialog` is a 1-line wrapper for the page.tsx import. This
keeps the close-guard logic (needs `rebuildBusy`) inside `SettingsView`.

### 2. SettingsDialogContent — two-pane layout

Built directly inside `SettingsView`'s return (not a separate component file),
since it needs access to `activeTab`, `isDirty`, `requestClose`, etc.

**Desktop (>767px):**
```tsx
<DialogContent
  className={cn(
    "w-[calc(100%-2rem)] max-w-4xl h-[min(720px,85dvh)] p-0 gap-0 overflow-hidden rounded-xl",
    "sm:max-w-4xl"
  )}
  showCloseButton={true}
>
  <div className="flex h-full">
    {/* Left nav — 232px, vertical TabsList */}
    <Tabs
      orientation="vertical"
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as SettingsTab)}
    >
      <TabsList
        className="flex flex-col w-[232px] h-full min-h-0 gap-1 p-4 border-r bg-muted/40"
      >
        {SETTINGS_TABS.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="justify-start h-9 rounded-md px-3 gap-2"
          >
            <tab.icon className="size-4 shrink-0" />
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Right pane — header + scrollable content */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Sticky section header */}
        <div className="shrink-0 border-b px-6 py-4">
          <h2 className="text-lg font-semibold">{SETTINGS_TABS.find(t => t.value === activeTab)?.label}</h2>
          <p className="text-muted-foreground text-xs mt-1">
            {SETTINGS_TAB_INTROS[activeTab]}
          </p>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable] p-6 min-h-0">
          {loadError && (
            <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
              Could not load server configuration.
            </p>
          )}

          <TabsContent value="general"><GeneralTab /></TabsContent>
          <TabsContent value="persona"><PersonaTab .../></TabsContent>
          ... etc ...
        </div>
      </div>
    </Tabs>
  </div>

  {/* Sibling dialogs (Edit Provider, NimProvider, ModelForm, Rebuild confirmation)
      rendered here, unchanged from current position after </Tabs> */}
</DialogContent>
```

Wait — `TabsContent` must be inside `Tabs`. The sibling dialogs are currently
rendered after `</Tabs>` but inside `<PageView>`. In the new structure they
move outside `<Tabs>` but stay inside `DialogContent`. That's fine — they're
plain `<Dialog>` siblings, positioned by Radix portal.

### 3. Close-guard logic

```tsx
const isDirty = useMemo(() => {
  // Add-provider form
  if (openaiFormOpen && (oaName || oaBaseUrl || oaApiKey)) return true;
  // Embedding form changes vs server snapshot
  if (settings?.embedding) {
    if (embApiKey) return true;
    if (embProviderId === "__onnx__") {
      if (embOnnxModelPath !== (settings.embedding.modelPath ?? "")) return true;
    } else {
      const snap = settings.embedding;
      if (embProviderId !== (snap.providerId ?? null)) return true;
      if (embBaseUrl !== (snap.baseUrl ?? "")) return true;
      if (embModel !== (snap.model ?? "")) return true;
      if (embDimensions !== (snap.dimensions ?? null)) return true;
    }
  }
  // Web search form changes
  const wsSnapshot = webSearchFormFromEntries(...);
  // (derive from settings.webSearch.providers or settings.store.websearch)
  ...
}, [open, settings, oaName, oaBaseUrl, oaApiKey, openaiFormOpen, ...]);

// PersonaTab reports dirtiness via callback
const [personaDirty, setPersonaDirty] = useState(false);
// Pass to PersonaTab: onDirtyChange={setPersonaDirty}

const requestClose = () => {
  if (rebuildBusy) return; // block — rebuild in progress
  if (isDirty || personaDirty) {
    // Show confirm dialog
    setConfirmDiscardOpen(true);
    return;
  }
  onOpenChange(false);
};
```

**Close paths wired to `requestClose`:**
- X button: `DialogPrimitive.Close` → `onOpenChange(false)` → intercepted by
  `handleOpenChange`. Actually, Radix fires `onOpenChange(false)` for X, Escape,
  and overlay-click. But the close button is our own `DialogPrimitive.Close`
  wrapper. We need to intercept BEFORE that.

Resolution: Don't use Radix's auto-close. Set `onOpenChange={handleOpenChange}`
where `handleOpenChange` checks `rebuildBusy` (block) then `isDirty` (confirm).
The X button calls `requestClose()` directly. Escape is handled by
`onEscapeKeyDown` on `DialogContent`. Overlay click by `onInteractOutside`.

```tsx
<DialogContent
  onOpenChange={handleOpenChange}  // primary path: fires false on X, ESC, overlay
  onEscapeKeyDown={(e) => { if (rebuildBusy) e.preventDefault(); }}
  onInteractOutside={(e) => { if (rebuildBusy) e.preventDefault(); }}
  ...
>
  {/* Custom close button that routes through requestClose */}
  <Button
    variant="ghost"
    size="icon-sm"
    className="absolute top-2 right-2"
    onClick={requestClose}
  >
    <XIcon />
    <span className="sr-only">Close</span>
  </Button>
```

Wait — `DialogPrimitive.Close` (the built-in X) fires `onOpenChange(false)`.
If we also override `onOpenChange`, that's fine, but we can't selectively
intercept only the X. The spec says "Close via the X button, overlay click,
and Escape." All three route through `onOpenChange(false)` in Radix. So
`handleOpenChange(false)` is the single chokepoint: check `rebuildBusy` → block;
check `isDirty` → confirm; else `onOpenChange(false)`.

The built-in `showCloseButton={true}` from `DialogContent` is fine — it calls
`DialogPrimitive.Close` which fires `onOpenChange(false)` → our handler. We
just need to disable it (or keep it; if rebuildBusy, the handler blocks
anyway). Actually, we should pass `showCloseButton={true}` and let
`handleOpenChange` do the guarding. Simpler.

### 4. Mobile (<768px)

`DialogContent` becomes full-screen:
```tsx
className={cn(
  "fixed inset-0 h-dvh w-full max-w-none rounded-none ...",
  "md:rounded-xl md:max-w-4xl md:h-[min(720px,85dvh)] md:w-[calc(100%-2rem)]"
)}
```

Left nav becomes a horizontal scrollable pill bar (consistent with the
`TabsList` on mobile in other views). Check `skills-view.tsx` or `plugins-view.tsx`
for the existing pattern... actually, the task says "follow whichever pattern
already exists in the codebase." Let me check: the existing `TabsList` in
settings-view already uses `overflow-x-auto` for a horizontal tab bar. On
mobile we keep that pattern — a single `TabsList` with `overflow-x-auto`
replacing the vertical nav.

**Mobile layout:**
```tsx
{/* Mobile: horizontal nav tabs, no vertical split */}
<div className="md:hidden">
  <TabsList className="w-full overflow-x-auto">
    {SETTINGS_TABS.map((tab) => (
      <TabsTrigger key={tab.value} value={tab.value} className="h-9">
        <tab.icon className="size-4" />
        {tab.label}
      </TabsTrigger>
    ))}
  </TabsList>
</div>

{/* Desktop: vertical split */}
<div className="hidden md:flex">
  ... vertical nav + content ...
</div>
```

Actually, simpler: keep ONE `Tabs` with vertical orientation always, and use
Tailwind `md:` breakpoints to swap the layout. The `TabsList` direction and
the surrounding flex container change via `md:` classes.

### 5. Icons for SETTINGS_TABS

Add `icon` field to each entry in `SETTINGS_TABS` (modifies `shared.ts`):

```ts
import { Gear, UserCircle, Plugs, Cpu, Funnel, Database, Wrench, Info } from "@phosphor-icons/react";

export const SETTINGS_TABS = [
  { value: "general", label: "General", icon: Gear },
  { value: "persona", label: "Persona", icon: UserCircle },
  { value: "provider", label: "Providers", icon: Plugs },
  { value: "embedding", label: "Embedding", icon: Cpu },
  { value: "reranker", label: "Reranker", icon: Funnel },
  { value: "database", label: "Database", icon: Database },
  { value: "tools", label: "Tools", icon: Wrench },
  { value: "about", label: "About", icon: Info },
] as const;
```

Wait — `SETTINGS_TABS` is `as const`, so adding `icon` (a React component)
breaks the type inference. The `SettingsTab` type is derived from the `value`.
Adding `icon` changes the tuple type but `SettingsTab = (typeof SETTINGS_TABS)[number]["value"]`
still works. The `as const` makes `icon` a component reference — that's fine
for rendering.

But tests import `SETTINGS_TABS` — check if any test references it. The
existing tests use `getByRole("tab", { name: "Providers" })` — they don't
import `SETTINGS_TABS` directly. Safe.

### 6. page.tsx changes

```diff
- const [view, setView] = useState<
-   | "chat" | "projects" | "cron" | "subagents"
-   | "settings" | "mcp" | "skills" | "plugins" | "statistics"
- >("chat");
+ const [view, setView] = useState<
+   | "chat" | "projects" | "cron" | "subagents"
+   | "mcp" | "skills" | "plugins" | "statistics"
+ >("chat");
+ const [settingsOpen, setSettingsOpen] = useState(false);

- const handleOpenSettings = () => {
-   setView("settings");
-   closeSidebarOnMobile();
- };
- const handleCloseSettings = () => setView("chat");
+ const handleOpenSettings = () => {
+   setSettingsOpen(true);
+   closeSidebarOnMobile();
+ };

  // In the render, after ChatArea:
- {view === "settings" && <SettingsView onBack={handleCloseSettings} />}
+ <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

  // Header chatTitle: remove the `view === "settings"` branch
  // Sidebar: settingsActive={settingsOpen} instead of settingsActive={view === "settings"}
```

The `SettingsDialog` is always rendered (just hidden when `open={false}`),
like a controlled `Dialog`. This keeps `SettingsView` mounted in the React
tree always — but Radix unmounts `DialogContent` when closed by default, so
its internal state resets. Good.

Wait — is it OK to always render `<SettingsDialog>`? Radix `Dialog` with
`open={false}` renders nothing (portal not mounted), so it's cheap. ✓

### 7. Chat stays mounted

`page.tsx` currently does `view !== "chat" && "hidden"` on the ChatArea div.
With the modal, `view` stays `"chat"`, so `hidden` class is never applied —
ChatArea stays visible behind the modal overlay. ✓

The modal overlay (`DialogOverlay` with `bg-black/40`) dims the chat visually
while keeping it interactive-context (actually, Radix modal traps focus, so
the chat is visible but not interactive while settings is open — that's the
expected modal behavior).

### 8. Test updates

**`settings-view.test.tsx`:**
- `render(<SettingsView onBack={...} />)` → `render(<SettingsView open={true} onOpenChange={() => {}} />)`
- All `getByRole("tab", { name: "Providers" })` assertions stay valid — Tabs
  are still in the DOM inside the DialogContent.
- `screen.getByRole("dialog")` — the outer settings dialog is now a
  `role="dialog"`. Inner dialogs (Edit Provider, Rebuild) are also
  `role="dialog"`. Tests that do `getByRole("dialog")` and then `within()`
  will still work, but if there are two open dialogs, `getByRole("dialog")`
  throws (multiple). Check: tests that open an inner dialog — the Rebuild
  confirmation and ModelForm. The test at line 630 opens the Rebuild dialog
  via `findByRole("dialog")` — if SettingsView is now inside a Dialog, there
  are two dialogs. Must use the innermost or be specific.

  Resolution: wrap `render(<SettingsView open={true} onOpenChange={() => {}} />)`
  — the outer Dialog renders. `getByRole("dialog")` now returns the outer
  one first? No — `getByRole` throws if multiple matches. Use
  `getAllByRole("dialog")` or scope. Actually, Radix portals in order —
  the innermost (highest z) is last in DOM. `getByRole("dialog")` with no
  filter throws. Tests need `screen.getByRole("dialog", { name: /rebuild/i })`
  or similar.

  Simpler: in tests that don't open an inner dialog, there's only one dialog.
  In tests that DO open an inner dialog, use `within` on the right container or
  `getAllByRole("dialog")`. Easiest fix: tests open SettingsView, then for inner
  dialogs use `screen.getByRole("dialog")` — but now there are 2. Must update.

  Best approach: for tests opening inner dialogs, use the dialog title as
  accessible name filter: `screen.getByRole("dialog", { name: "Rebuild embeddings?" })`.

  But wait — the outer settings modal has `DialogTitle` "Settings" (visually
  hidden). So there's always a `role="dialog"` with accessible name "Settings"
  in the DOM when open. Inner dialogs have their own titles. So:
  - Normal test: `getByRole("dialog")` → multiple? The outer has name "Settings".
  If the test just wants ANY dialog... actually the test at line 648 does
  `await screen.findByRole("dialog")` after opening SettingsView — that's the
  Rebuild dialog (which triggers on mount). Now there are TWO: outer "Settings"
  + inner "Rebuild embeddings?". `findByRole("dialog")` throws.

  Fix: `findByRole("dialog", { name: /rebuild embeddings/i })` or
  `getAllByRole("dialog")[1]`.

  This needs careful per-test fixes. Let me count: the Rebuild tests (lines
  630-807) and the ModelForm test (line 496) and Edit Provider test (line 590)
  all interact with inner dialogs. Each needs updating.

  Actually — re-reading the test: `render(<SettingsView onBack={() => {}} />)`.
  If we make `SettingsView` accept `open`/`onOpenChange`, and the test passes
  `open={true}`, then the outer Dialog is open AND the Rebuild inner dialog
  auto-opens. Two dialogs. The `findByRole("dialog")` calls need to target the
  right one.

  Simplest fix for all tests: use `screen.getByRole("dialog", { name: /Settings/i })`
  to target the outer, or `name: /rebuild|edit provider|add model/i` for inner.

  Hmm, but the DialogTitle for the outer is visually-hidden "Settings" — is it
  exposed as the dialog's accessible name? Yes, `DialogPrimitive.Title` sets
  the accessible name on the content element. So `getByRole("dialog", { name: "Settings" })`
  works for the outer.

**`settings-dialog.test.tsx` (new):**
- Renders `<SettingsDialog open={true} onOpenChange={...} />`
- Tests: opens when open, shows General by default, switches sections via nav,
  closes on Escape, closes on X button, does not render content when closed.

**Dirty form + PersonaTab `onDirtyChange`:**
- `PersonaTab` will get a new `onDirtyChange` prop. Its existing tests (if any)
  that render `<PersonaTab>` directly need that prop as optional. Check:
  `persona-settings-tab.test.tsx` exists. Read it.

## Open Questions for Reviewer

1. **PersonaTab dirty reporting:** `PersonaTab` has local `name`/`instructions`
   state that differs from props until saved. Adding `onDirtyChange` changes
   its props. Existing `persona-settings-tab.test.tsx` will need a dummy
   `onDirtyChange` prop or it must be optional. I'll make it optional
   (`onDirtyChange?: (dirty: boolean) => void`) to avoid breaking direct renders.

2. **`isDirty` for web search:** comparing `wsForm` against the snapshot requires
   deriving the same form from `settings.webSearch.providers` or
   `settings.store.websearch`. This is a pure computation — acceptable.

3. **Inner dialog z-order:** Radix Dialog renders via Portal. Nested Dialogs
   get nested Portals — z-order is handled by Radix's internal `z-index`
   increments. `Select`/`Popover`/`Tooltip` inside the modal use `Portal` too.
   No new z-index needed unless we see stacking issues — test and fix if found.

## Verification

- `pnpm test` — all existing + new tests pass.
- `pnpm exec tsc --noEmit` — no type errors.
- `pnpm exec eslint` — no lint errors.
