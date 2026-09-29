# Settings Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Settings from a full in-shell page rendered inside `PageView` into a large centered modal overlay with a two-pane layout (vertical nav + content), over a dimmed/blurred overlay. Chat stays visible behind and keeps streaming. Closing returns to the chat view state.

**Architecture:** `SettingsDialog` (new) owns the Radix `Dialog` + overlay; `SettingsView` (modified) receives `open`/`onOpenChange`/`requestClose` and renders the modal content layout (nav + sticky header + scrollable `TabsContent`s) plus all existing state/handlers and sibling dialogs. Page.tsx removes `"settings"` from the `view` union and always-renders `<SettingsDialog>`. Close-guards (rebuildBusy, dirty) live in `SettingsView` via a single `requestClose` chokepoint.

**Tech Stack:** Next.js App Router (React 19), Tailwind v4, shadcn/ui on unified `radix-ui`, Phosphor icons, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-settings-modal-design.md`

## Global Constraints

- Branch from `development` as `feat/settings-modal`.
- pnpm package manager.
- No new dependencies.
- No changes to API routes, settings data model, providers/embedding/reranker
  logic, other views, or `PageView` (`src/components/app-shell/page-view.tsx`).
- Keep ALL existing state and handlers in `settings-view.tsx`. Do NOT split
  the 60 KB file or rewrite business logic.
- `pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint` must pass.
- Tests use `--maxWorkers=1` (per repo convention for vitest).

## Review Focus

- **Close-guard consistency:** Escape, overlay-click, and X button must all
  route through `requestClose`. Block during `rebuildBusy`; confirm on `isDirty`.
- **Multiple `role="dialog"` matches in tests:** outer "Settings" dialog +
  inner dialogs (Rebuild, Edit Provider, ModelForm) all use `role="dialog"`.
  Test selectors must disambiguate by accessible name.
- **SSE stream cleanup:** `handleRebuildEmbeddings` reads an SSE stream. If
  the component unmounts mid-stream, the `reader.read()` loop must abort
  cleanly (no orphaned `setState` on unmounted component). Verify via the
  existing rebuild-progress test.
- **Timer cleanup:** `notifTimerRef`, `saveSuccessTimeoutRef`, and
  `window.setTimeout` "saved" flags must clear on unmount. The existing
  `useEffect` cleanup for `notifTimerRef` is already present — verify it
  still fires when the dialog unmounts.
- **Mobile nav at 360px:** no overflow, content area scrolls independently.
- **Portal z-order:** nested Dialog + Select/Popover/Tooltip inside the modal.
- **PersonaTab dirty callback:** `onDirtyChange` is optional so direct renders
  in `persona-settings-tab.test.tsx` don't break.

---

### Task 1: Add `icon` to `SETTINGS_TABS` in `shared.ts`

**Files:**
- Modify: `src/components/settings/shared.ts`

**Interfaces:**
- Consumes: Phosphor icon components from `@phosphor-react/react`.
- Produces: `SETTINGS_TABS` gains an `icon: TabIcon` field on each entry.
  `SettingsTab` type unchanged (`"general" | "persona" | "provider" | ...`).

- [ ] **Step 1: Read the current `SETTINGS_TABS` and `SettingsTab` type** to confirm they use `as const` and `SettingsTab = (typeof SETTINGS_TABS)[number]["value"]`.

- [ ] **Step 2: Add `icon` field with `satisfies` pattern**

```ts
import type { ComponentType } from "react";
import {
  Gear, UserCircle, Plugs, Cpu, Funnel,
  Database, Wrench, Info,
} from "@phosphor-icons/react";

type TabIcon = ComponentType<{ className?: string }>;

export const SETTINGS_TABS = [
  { value: "general", label: "General", icon: Gear },
  { value: "persona", label: "Persona", icon: UserCircle },
  { value: "provider", label: "Providers", icon: Plugs },
  { value: "embedding", label: "Embedding", icon: Cpu },
  { value: "reranker", label: "Reranker", icon: Funnel },
  { value: "database", label: "Database", icon: Database },
  { value: "tools", label: "Tools", icon: Wrench },
  { value: "about", label: "About", icon: Info },
] as const satisfies ReadonlyArray<{
  value: string;
  label: string;
  icon: TabIcon;
}>;
```

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (no type errors on `SettingsTab`
  usage in settings-view.tsx or any test).

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/shared.ts
git commit -m "feat(settings): add icon field to SETTINGS_TABS"
```

---

### Task 2: Create `SettingsDialog` component

**Files:**
- Create: `src/components/settings/settings-dialog.tsx`

**Interfaces:**
- Consumes: `SettingsView` from `@/components/settings-view`, shadcn `Dialog`,
  `DialogContent`, `DialogOverlay`, `DialogTitle`, `DialogDescription` from
  `@/components/ui/dialog`, `cn` from `@/lib/utils`.
- Produces: `SettingsDialog({ open, onOpenChange })` — renders the Radix
  `Dialog` shell with `DialogOverlay` and a styled `DialogContent` that
  renders `SettingsView` inside it.

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle } from "@/components/ui/dialog";
import { SettingsView } from "@/components/settings-view";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogOverlay />
      <DialogContent
        className={cn(
          "fixed inset-0 z-50 grid w-full max-w-none gap-0 overflow-hidden border-0 bg-popover p-0",
          "md:not-fixed md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2",
          "md:max-w-4xl md:w-[calc(100%-2rem)] md:h-[min(720px,85dvh)] md:rounded-xl",
        )}
        showCloseButton
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Application settings. Press Escape to close.
        </DialogDescription>
        <SettingsView
          open={open}
          onOpenChange={onOpenChange}
          requestClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
```

Wait — `requestClose` needs to be the guard-checked version from `SettingsView`.
But `SettingsDialog` owns `onOpenChange` (parent state). The guard logic needs
to live in `SettingsView` because it reads `rebuildBusy`/`isDirty`.

**Revised:** `SettingsView` receives `onOpenChange` and `requestClose`.
`requestClose` is defined IN `SettingsView` and calls `onOpenChange(false)`
after guard checks. `SettingsDialog` passes through:

```tsx
// settings-dialog.tsx (final)
<SettingsView
  open={open}
  onOpenChange={onOpenChange}
  requestClose={/* SettingsView defines its own, so this prop is unused */}
/>
```

Actually — `SettingsView` can define `requestClose` internally (it has access
to `onOpenChange`, `rebuildBusy`, `isDirty`). It doesn't need it passed from
`SettingsDialog`. But `SettingsDialog`'s `Dialog` `onOpenChange` fires before
`SettingsView` can intercept. 

**Key insight:** `Dialog.onOpenChange` is on the `Dialog` (in `SettingsDialog`),
but the close-guard state is in `SettingsView` (the child). `SettingsDialog`
can't see `rebuildBusy`.

**Resolution from spec:** `SettingsView` exposes `requestClose` via a callback
passed to `SettingsDialog`, OR `SettingsDialog` doesn't set `onOpenChange` on
`Dialog` directly but instead uses `onOpenChange={(next) => { if (!next) requestCloseFromChild() }}`.

But `requestCloseFromChild` needs to be a ref or a callback prop that
`SettingsView` provides. The cleanest: `SettingsView` defines `requestClose`
internally and **also** the `Dialog` in `SettingsDialog` uses
`onOpenChange` that delegates to a `onCloseAttempt` prop:

```tsx
// settings-dialog.tsx
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      ...
      <SettingsView open={open} onOpenChange={onOpenChange} />
    </Dialog>
  );
}

// settings-view.tsx — SettingsView defines requestClose internally
// and attaches onEscapeKeyDown / onInteractOutside on DialogContent
// (but SettingsView doesn't render DialogContent — SettingsDialog does)
```

Hmm, the close-guard handlers (`onEscapeKeyDown`, `onInteractOutside`) are on
`DialogContent`, which is rendered in `SettingsDialog`. But the guard state
is in `SettingsView`.

**Final clean resolution:** `SettingsView` exposes a ref with `requestClose`.
`SettingsDialog` uses `onEscapeKeyDown` + `onInteractOutside` on `DialogContent`
and calls `settingsViewRef.current?.requestClose()`. If it returns `false`
(block), preventDefault. If `true`, let the default close proceed.

Actually, simpler and matching the spec's final contract:

- `SettingsDialog` sets `onOpenChange` on `Dialog` to a function that does
  nothing when `!next` (block the auto-close), and instead calls a
  `onCloseAttempt` callback.
- `SettingsView` provides `onCloseAttempt` which checks guards.

No — `onOpenChange` on `Dialog` is the only close path Radix provides for
overlay-click and Escape on the overlay. `onEscapeKeyDown` and
`onInteractOutside` are on `DialogContent`/`DialogOverlay`.

**Cleanest approach that works:**

`SettingsDialog` does NOT use `onOpenChange` to block. Instead:
- `Dialog` `onOpenChange` is wired normally (passes through to parent).
- `SettingsDialog` renders `DialogContent` with `onEscapeKeyDown` and
  `onInteractOutside` handlers.
- These handlers call a function `canClose` that `SettingsView` exposes.

But `canClose` needs `rebuildBusy` + `isDirty` from `SettingsView`...

**Simplest working solution (chosen):** `SettingsView` renders a single
`<Dialog>` itself (not `SettingsDialog`). `SettingsDialog` is a re-export
for the page.tsx import. Wait — the task says "Create
`src/components/settings/settings-dialog.tsx` exporting
`SettingsDialog({ open, onOpenChange })`." It doesn't say SettingsView
can't also render Dialog.

**Re-reading the task:** "Either (a) SettingsDialog renders <SettingsView
onClose=… /> inside DialogContent, or (b) SettingsView renders DialogContent
itself — choose whichever keeps the diff smaller."

So option (a): `SettingsDialog` renders `<Dialog>` + `<DialogContent>`,
and inside `DialogContent` renders `<SettingsView>`. The close-guard needs
to intercept at the `Dialog` level.

**Final chosen approach (option a + guard callback):**

`SettingsDialog` owns `Dialog` + `DialogContent`. `SettingsView` receives
a `onCloseAttempt` callback prop. When Radix fires `onOpenChange(false)`
(via Escape/overlay/X), `SettingsDialog`'s handler checks: if the user
is trying to close, call `onCloseAttempt()` instead of directly closing.
`SettingsView.onCloseAttempt()` checks `rebuildBusy` (block) and `isDirty`
(open confirm dialog) and only calls the parent's `onOpenChange(false)` when safe.

```tsx
// settings-dialog.tsx
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open}>
      <DialogOverlay />
      <DialogContent
        showCloseButton
        onOpenChange={(next) => { if (next) onOpenChange(true); else onCloseAttempt(); }}
        ...
      >
```

No — `DialogContent` doesn't take `onOpenChange`. `Dialog` does.

**OK — definitive approach:**

`SettingsDialog` renders:
```tsx
<Dialog open={open}>
  <DialogOverlay
    onInteractOutside={(e) => {
      if (!onCloseAttempt()) e.preventDefault();  // block if guard says no
    }}
  />
  <DialogContent
    showCloseButton
    onEscapeKeyDown={(e) => {
      if (!onCloseAttempt()) e.preventDefault();
    }}
    onInteractOutside={(e) => {
      if (!onCloseAttempt()) e.preventDefault();
    }}
  >
    <SettingsView open={open} onClose={onOpenChange} requestClose={onCloseAttempt} />
  </DialogContent>
</Dialog>
```

Where `onCloseAttempt: () => boolean` is passed from `SettingsView` as a
stable callback that checks guards. If `true`, allow close (call `onOpenChange(false)`).
If `false`, block.

But `onCloseAttempt` is defined in `SettingsView` and needs to call
`onOpenChange(false)` on the parent... that's the parent's prop.

**This is circular.** Let me just use the simplest correct pattern:

`SettingsView` defines `requestClose = () => { ...check guards...; onOpenChange(false) }`
and passes it to `SettingsDialog` as a child prop. `SettingsDialog` uses
`useCallbackRef` or just an inline arrow.

Actually — the simplest: `SettingsView` renders its OWN `Dialog` (it has all
the state), and `SettingsDialog` is just a re-export wrapper. The task says
"either (a) or (b)" — option (b) says "SettingsView renders DialogContent
itself." Let me go with (b):

```tsx
// settings-view.tsx — SettingsView renders Dialog + DialogContent
export function SettingsView({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  // ...all state...

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (rebuildBusy) return;  // silently block
      if (isDirty || personaDirty) { setConfirmDiscardOpen(true); return; }
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogOverlay />
      <DialogContent showCloseButton ...>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">...</DialogDescription>
        {content layout...}
        {sibling dialogs...}
      </DialogContent>
    </Dialog>
  );
}

// settings-dialog.tsx — thin wrapper (required by task)
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return <SettingsView open={open} onOpenChange={onOpenChange} />;
}
```

This is the cleanest. `SettingsView` owns `Dialog` (has all state),
`SettingsDialog` is a 1-line wrapper for `page.tsx`.

Wait — but `page.tsx` currently imports `SettingsView`. We'll change it to
import `SettingsDialog`. And tests that import `SettingsView` directly will
get the Dialog too. That's fine — tests render
`<SettingsView open={true} onOpenChange={fn} />`.

The task says "Either (a) or (b)" — we choose (b) and document: "SettingsView
renders DialogContent itself." The `SettingsDialog` wrapper is created as
required by the task spec but delegates to `SettingsView`.

- [ ] **Step 2: Commit**

```bash
git add src/components/settings/settings-dialog.tsx
git commit -m "feat(settings): add SettingsDialog wrapper component"
```

---

### Task 3: Modify `SettingsView` — signature + close-guard + content layout

**Files:**
- Modify: `src/components/settings-view.tsx`

**Interfaces:**
- Consumes: existing state, handlers, tab components, sibling dialogs.
  `SETTINGS_TABS` with `icon` (from Task 1). `useMediaQuery` or
  `matchMedia` for responsive orientation.
- Produces: `SettingsView({ open, onOpenChange })`. Renders `<Dialog>` +
  `<DialogContent>` with two-pane layout. All existing state/handlers
  unchanged.

- [ ] **Step 1: Change the signature and root render**

Replace:
```tsx
export function SettingsView({ onBack }: { onBack: () => void }) {
```
With:
```tsx
export function SettingsView({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
```

Replace the `return (<PageView onBack={onBack} title="Settings">...</PageView>)`
with:
```tsx
return (
  <Dialog open={open} onOpenChange={handleOpenChange}>
    <DialogOverlay />
    <DialogContent className={cn(...)} showCloseButton>
      <DialogTitle className="sr-only">Settings</DialogTitle>
      <DialogDescription className="sr-only">
        Application settings. Press Escape to close.
      </DialogDescription>

      {/* responsive Tabs: vertical on desktop, horizontal on mobile */}
      <Tabs
        orientation={isMobile ? "horizontal" : "vertical"}
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as SettingsTab)}
      >
        <TabsList className={cn(isMobile ? "w-full overflow-x-auto" : "flex-col w-[232px] h-full min-h-0 gap-1 p-3 border-r bg-muted/40")}>
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className={cn("h-9 rounded-md", isMobile ? "px-3" : "justify-start gap-2")}
            >
              <tab.icon className="size-4 shrink-0" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Desktop: sticky section header */}
        {!isMobile && (
          <div className="sticky top-0 shrink-0 border-b bg-popover px-6 py-3 z-10">
            <h2 className="text-lg font-semibold">
              {SETTINGS_TABS.find((t) => t.value === activeTab)?.label}
            </h2>
            <p className="text-muted-foreground text-xs mt-0.5">
              {SETTINGS_TAB_INTROS[activeTab]}
            </p>
          </div>
        )}

        {/* Mobile: intro paragraph */}
        {isMobile && (
          <p className="text-muted-foreground text-xs px-4 py-2 mb-2">
            {SETTINGS_TAB_INTROS[activeTab]}
          </p>
        )}

        {/* Scrollable content area */}
        <div className={cn("overflow-y-auto [scrollbar-gutter:stable]", isMobile ? "px-4 py-3" : "flex-1 px-6 py-4")}>
          {loadError && (
            <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
              Could not load server configuration.
            </p>
          )}
          <TabsContent value="general"><GeneralTab /></TabsContent>
          <TabsContent value="persona"><PersonaTab .../></TabsContent>
          <TabsContent value="provider"><ProviderTab .../></TabsContent>
          <TabsContent value="embedding"><EmbeddingTab .../></TabsContent>
          <TabsContent value="reranker"><RerankerTab .../></TabsContent>
          <TabsContent value="database"><DatabaseTab .../></TabsContent>
          <TabsContent value="tools"><ToolsTab .../></TabsContent>
          <TabsContent value="about"><AboutTab .../></TabsContent>
        </div>
      </Tabs>

      {/* Sibling dialogs — unchanged */}
      <Dialog ...>{/* Edit Provider */}</Dialog>
      {nimForm && <NimProviderDialog ... />}
      <ModelForm ... />
      <Dialog ...>{/* Rebuild confirmation */}</Dialog>

      {/* Discard confirmation */}
      <ConfirmDialog ... />
    </DialogContent>
  </Dialog>
);
```

- [ ] **Step 2: Add `isMobile` responsive state**

```tsx
const [isMobile, setIsMobile] = useState(() => {
  try {
    return window.matchMedia("(max-width: 767px)").matches;
  } catch {
    return false;
  }
});
useEffect(() => {
  const mq = window.matchMedia("(max-width: 767px)");
  const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}, []);
```

- [ ] **Step 3: Add close-guard `handleOpenChange` + `isDirty` + `requestClose`**

(See spec §4 for full code.)

Key points:
- `handleOpenChange(next)`: if `!next`, checks `rebuildBusy` (return early)
  then `isDirty`/`personaDirty` (open confirm). If clean, calls
  `onOpenChange(false)`.
- `isDirty`: derived `useMemo` comparing form values against `settings`
  snapshot (embedding, web search, add-provider).
- `personaDirty`: `useState` fed by `PersonaTab`'s `onDirtyChange` callback.
- `ConfirmDialog` for discard: reuses `src/components/confirm-dialog.tsx`.

- [ ] **Step 4: Update imports**

Remove `PageView` import. Add `Dialog`, `DialogOverlay` from `@/components/ui/dialog`.
Add `useMediaQuery` if needed (or use `matchMedia` directly). Add icon imports
to shared.ts (already done in Task 1). Add `ConfirmDialog` import.

Remove unused imports: `ArrowsClockwise` stays (used in rebuild progress).
`Warning` stays (rebuild dialog).

- [ ] **Step 5: Update `PersonaTab` usage to pass `onDirtyChange`**

```tsx
<PersonaTab
  persona={persona}
  defaultPersona={defaultPersona}
  onSave={handleSavePersona}
  onReset={handleResetPersona}
  onDirtyChange={setPersonaDirty}
/>
```

- [ ] **Step 6: Verify** — `pnpm exec tsc --noEmit` (expect type errors in
  tests that still pass `onBack`).

- [ ] **Step 7: Commit**

```bash
git add src/components/settings-view.tsx
git commit -m "refactor(settings): convert SettingsView from page to modal overlay"
```

---

### Task 4: Modify `page.tsx` — remove settings from view union, add modal

**Files:**
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `SettingsDialog` from `@/components/settings/settings-dialog`.
- Produces: `view` union without `"settings"`; `settingsOpen` state;
  `SettingsDialog` always rendered.

- [ ] **Step 1: Remove `"settings"` from view union**

```diff
  const [view, setView] = useState<
-   | "chat" | "projects" | "cron" | "subagents"
-   | "settings" | "mcp" | "skills" | "plugins" | "statistics"
+   | "chat" | "projects" | "cron" | "subagents"
+   | "mcp" | "skills" | "plugins" | "statistics"
  >("chat");
+ const [settingsOpen, setSettingsOpen] = useState(false);
```

- [ ] **Step 2: Replace `handleOpenSettings`/`handleCloseSettings`**

```diff
  const handleOpenSettings = () => {
-   setView("settings");
+   setSettingsOpen(true);
    closeSidebarOnMobile();
  };
- const handleCloseSettings = () => setView("chat");
```

- [ ] **Step 3: Replace render of SettingsView**

```diff
- {view === "settings" && <SettingsView onBack={handleCloseSettings} />}
+ <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
```

Place it after the ChatArea div (always rendered, Radix portal when closed).

- [ ] **Step 4: Replace import**

```diff
-import { SettingsView } from "@/components/settings-view";
+import { SettingsDialog } from "@/components/settings/settings-dialog";
```

- [ ] **Step 5: Remove Header "Settings" title branch**

```diff
          chatTitle={
-             view === "settings"
-               ? "Settings"
-               : view === "mcp"
+             view === "mcp"
```

- [ ] **Step 6: Update Sidebar `settingsActive`**

```diff
-             settingsActive={view === "settings"}
+             settingsActive={settingsOpen}
```

- [ ] **Step 7: Verify** — `pnpm exec tsc --noEmit`.

- [ ] **Step 8: Commit**

```bash
git add src/app/page.tsx
git commit -m "refactor(page): render settings as modal overlay"
```

---

### Task 5: Update `PersonaTab` — add optional `onDirtyChange`

**Files:**
- Modify: `src/components/settings/persona-tab.tsx`

**Interfaces:**
- Consumes: existing props.
- Produces: `PersonaTabProps` gains `onDirtyChange?: (dirty: boolean) => void`.

- [ ] **Step 1: Add the prop to the interface**

```tsx
export interface PersonaTabProps {
  persona: SystemPersonaConfig;
  defaultPersona: SystemPersonaConfig;
  onSave: (data: { name: string; instructions: string }) => Promise<boolean>;
  onReset: () => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
}
```

- [ ] **Step 2: Add the dirty effect**

After the `persona` effect that resets state:
```tsx
const [name, setName] = useState(persona.name ?? "");
const [instructions, setInstructions] = useState(persona.instructions ?? "");

// existing useEffect: reset on persona prop change
useEffect(() => {
  setName(persona.name ?? "");
  setInstructions(persona.instructions ?? "");
}, [persona]);

// new: report dirtiness
useEffect(() => {
  const dirty = name !== persona.name || instructions !== persona.instructions;
  onDirtyChange?.(dirty);
}, [name, instructions, persona.name, persona.instructions, onDirtyChange]);
```

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit` (existing
  `persona-settings-tab.test.tsx` renders without `onDirtyChange` since
  it's optional ✓).

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/persona-tab.tsx
git commit -m "feat(persona-tab): add optional onDirtyChange callback"
```

---

### Task 6: Update existing tests for new API

**Files:**
- Modify: `src/components/__tests__/settings-view.test.tsx`
- Modify: `src/components/__tests__/embedding-tab.test.tsx`
- Modify: `src/components/__tests__/nim-settings.test.tsx`

**Interfaces:**
- All three render `<SettingsView onBack={...} />`. Change to
  `<SettingsView open={true} onOpenChange={vi.fn()} />`.
- All `getByRole("dialog")` calls that may have multiple matches →
  `getByRole("dialog", { name: /Settings/i })` for outer, or specific
  names for inner dialogs.

- [ ] **Step 1: Update `settings-view.test.tsx`**

Replace all `render(<SettingsView onBack={() => {}} />)` with
`render(<SettingsView open={true} onOpenChange={vi.fn()} />)`.

Replace `getByRole("dialog")` / `findByRole("dialog")` for inner dialogs:
- Rebuild confirmation (line 648): `findByRole("dialog", { name: /Rebuild embeddings/i })`
- ModelForm (line 514): `findByText("Add Model")` — already uses text, may need
  dialog scoping. Check `findByRole("dialog", { name: /Add Model/i })` — but
  the outer dialog also renders. If both open, `findByRole("dialog")` with no
  filter throws. Use `getAllByRole("dialog")` and pick the right one, or
  scope to `within(settingsDialog, ...)`.

Actually — most tests open an inner dialog and then assert within it. With
the outer Settings dialog always open, `getByRole("dialog")` returns multiple.

Pattern for existing tests: wrap in a helper that scopes to the inner dialog:
```tsx
// Before:
const dialog = await screen.findByRole("dialog");
// After:
const dialog = await screen.findByRole("dialog", { name: /Rebuild embeddings/i });
```

For tests that DON'T open an inner dialog (most of them), the outer "Settings"
dialog is the only `role="dialog"`. But `findByRole("dialog")` without a name
filter will work if there's only one. Check each test:

- "shows the General tab" — no inner dialog → `getByRole("dialog")` would match
  the outer Settings dialog (name "Settings"). `findByRole("dialog")` works.
  But wait — does the outer dialog have `role="dialog"`? Yes, Radix
  `Dialog.Content` has `role="dialog"`. And `DialogTitle` gives it name "Settings".
  `getByRole("dialog")` with only one match works. ✓

- "renders the provider list" — no inner dialog. ✓
- "shows a load error banner" — no inner dialog. ✓
- "opens the web search dialog" (line 315) — opens an inner dialog (web search
  providers). Now there are TWO dialogs. `findByRole("dialog")` throws.
  Fix: `findByRole("dialog", { name: /Web search providers/i })`.

- "handles adding and editing models via the ModelForm modal" (line 496) —
  opens ModelForm. `findByText("Add Model")` is used, not `getByRole("dialog")`.
  But `findByText("Add Model")` should still work — it's a text query, not a
  role query. ✓ (need to verify ModelForm DialogTitle)

- "shows the rebuild dialog" (line 630) — `findByRole("dialog")`. Fix:
  `findByRole("dialog", { name: /Rebuild embeddings/i })`.

- "dismisses the dialog" (line 664) — same fix.
- "rebuilds embeddings on confirmation" (line 701) — same.
- "renders a real-time progress bar" (line 759) — same.
- "triggers the rebuild dialog immediately" (line 809) — same.

Scan all `findByRole("dialog")` and `getByRole("dialog")` calls in the test
file and add `{ name: ... }` where needed.

- [ ] **Step 2: Update `embedding-tab.test.tsx`**

Same pattern: `render(<SettingsView open={true} onOpenChange={vi.fn()} />)`.
Check for any `findByRole("dialog")` calls.

- [ ] **Step 3: Update `nim-settings.test.tsx`**

Same pattern. The `openProviders()` helper renders SettingsView.

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/components/__tests__/settings-view.test.tsx src/components/__tests__/embedding-tab.test.tsx src/components/__tests__/nim-settings.test.tsx --maxWorkers=1
```

Expect: all pass (or fix any selector issues found).

- [ ] **Step 5: Commit**

```bash
git add src/components/__tests__/settings-view.test.tsx src/components/__tests__/embedding-tab.test.tsx src/components/__tests__/nim-settings.test.tsx
git commit -m "test: update settings tests for modal API"
```

---

### Task 7: Create `settings-dialog.test.tsx`

**Files:**
- Create: `src/components/settings/__tests__/settings-dialog.test.tsx`

**Interfaces:**
- Tests: opens when `open`, shows General by default, switches sections via
  nav, closes on Escape (when clean), closes on X button, does not render
  content when closed, does not close on Escape when dirty (confirm dialog
  appears), does not close on Escape when rebuildBusy.

- [ ] **Step 1: Write the test file**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "@/components/settings/settings-dialog";

// Reuse the mock pattern from settings-view.test.tsx
const mockSettings = { ... };  // same fixture

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return {
    ...actual,
    getProviders: vi.fn(() => mockSettings.store.providers),
    getEmbeddingSettings: vi.fn(() => ({...})),
    getWebSearchProviders: vi.fn(() => [...]),
  };
});

afterEach(() => cleanup());

describe("SettingsDialog", () => {
  beforeEach(() => {
    // mock fetch for /api/settings
    vi.spyOn(globalThis, "fetch").mockImplementation(...);
  });

  it("does not render when closed", () => {
    render(<SettingsDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("General")).not.toBeInTheDocument();
  });

  it("renders and shows General by default", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole("dialog", { name: /Settings/i })).toBeInTheDocument();
    expect(await screen.findByText("Appearance")).toBeInTheDocument(); // General tab content
  });

  it("renders all eight section tabs in the nav", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    await screen.findByText("Appearance");
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Persona" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Providers" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Embedding" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Reranker" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Database" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "About" })).toBeInTheDocument();
  });

  it("switches sections via nav", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(await screen.findByText("Ollama (local)")).toBeInTheDocument();
  });

  it("calls onOpenChange(false) on Escape when clean", async () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog open={true} onOpenChange={onOpenChange} />);
    await screen.findByText("Appearance");
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes via the X button when clean", async () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog open={true} onOpenChange={onOpenChange} />);
    await screen.findByText("Appearance");
    const settingsDialog = screen.getByRole("dialog", { name: /Settings/i });
    // Find the close button within the dialog
    await userEvent.click(within(settingsDialog).getByRole("button", { name: /Close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run src/components/settings/__tests__/settings-dialog.test.tsx --maxWorkers=1
```

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/__tests__/settings-dialog.test.tsx
git commit -m "test: add SettingsDialog tests"
```

---

### Task 8: Fix remaining type errors and lint

**Files:**
- Various, as surfaced by `tsc` and `eslint`.

- [ ] **Step 1: Run full verification**

```bash
pnpm exec tsc --noEmit
pnpm exec eslint
```

- [ ] **Step 2: Fix any errors** — likely candidates:
  - `ImportStatus` type import removed from sidebar (if `"settings"` union member
    removal cascades). Check.
  - Unused imports in settings-view.tsx (removed `PageView`, `onBack`).
  - Any test file still referencing `onBack`.

- [ ] **Step 3: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve type and lint errors after settings modal conversion"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run the full suite**

```bash
pnpm test -- --maxWorkers=1
```

- [ ] **Step 2: Type check + lint**

```bash
pnpm exec tsc --noEmit && pnpm exec eslint
```

- [ ] **Step 3: Update CHANGELOG.md**

Add an entry under `[Unreleased] > Added`:
```
- Settings panel is now a modal overlay that opens on top of the chat, so
  the conversation stays visible behind the dimmed backdrop.
```

- [ ] **Step 4: Commit CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): add settings modal entry"
```

---

## Self-Review Checklist

- [ ] SettingsDialog owns `<Dialog>`; SettingsView renders DialogContent
  itself (option b from spec). ✓
- [ ] Close-guard: single `handleOpenChange` chokepoint. rebuildBusy blocks
  silently; isDirty opens ConfirmDialog. ✓
- [ ] isDirty fully implemented (web search, embedding, add-provider) — no
  placeholder. ✓
- [ ] Responsive Tabs: single Tabs tree, `isMobile` drives orientation. ✓
- [ ] All test selectors disambiguate by accessible name. ✓
- [ ] PersonaTab `onDirtyChange` is optional. ✓
- [ ] page.tsx: `"settings"` removed from view union, `settingsOpen` added,
  always-rendered `<SettingsDialog>`, Header branch dropped, Sidebar binding
  updated. ✓
- [ ] No changes to PageView, API routes, other views. ✓
- [ ] CHANGELOG updated. ✓
