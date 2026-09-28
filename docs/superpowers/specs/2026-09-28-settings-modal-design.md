# Settings Modal Design Spec

Date: 2026-09-28
Status: Final (pending implementation plan)

## Goal

Convert Settings from a full in-shell page (`view === "settings"` rendered
inside `PageView`) into a large centered modal overlay: a two-pane layout with
a vertical navigation list on the left and the active section's content on the
right, over a dimmed/blurred overlay. Settings opens on top of whatever the
user is doing (chat stays visible behind the overlay and keeps streaming) —
closing returns to exactly where they were.

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
  `getByRole("tab", { name: "Providers" })` — tab role assertions must stay
  valid.
- Design tokens: `bg-popover`, `border-border`, `text-muted-foreground`, etc.
  No new colors or fonts.

## Non-goals

- The old spec `2026-08-30-settings-shell-grid-design.md` (full-width grid page)
  was NOT implemented — confirmed by reading it and the current code. We do NOT
  follow it.
- No redesign of tab internals (`tabs.tsx`, `tools-tab.tsx`, `persona-tab.tsx`,
  `reranker-tab.tsx`) unless layout visibly breaks in the modal width.

---

## Architecture

### Ownership: `SettingsDialog` owns `<Dialog>`, `SettingsView` owns content

- `SettingsDialog` (new file) owns the Radix `Dialog` primitive and the
  `DialogOverlay`. It renders `SettingsView` inside `DialogContent`.
- `SettingsView` no longer renders its own `Dialog`. It receives `open` /
  `onOpenChange` / `requestClose` and renders the **content layout** + all
  existing state, handlers, and sibling dialogs (Edit Provider, NimProvider,
  ModelForm, Rebuild confirmation).
- `SettingsView`'s close-guard (`rebuildBusy`, `isDirty`, `personaDirty`)
  lives inside it and is wired to `DialogContent`'s `onOpenChange` +
  `onEscapeKeyDown` + `onInteractOutside` handlers — all of which are in the
  same component, so the guard sees live state.

### Why this ownership

`rebuildBusy` is local to `SettingsView`. If `SettingsDialog` owned the `Dialog`,
it couldn't read `rebuildBusy` without lifting all 60 KB of state up — which the
task forbids. So `SettingsView` renders the `DialogContent` and its close-guard
handlers; `SettingsDialog` renders the `Dialog` + overlay shell.

### File map

- **Create** `src/components/settings/settings-dialog.tsx` — `SettingsDialog`
  renders `<Dialog>` + `<DialogOverlay>` + `<DialogContent>` with modal styling.
  Passes `open`/`onOpenChange`/`requestClose` to `SettingsView`.
- **Modify** `src/app/page.tsx` — remove `"settings"` from `view` union, add
  `settingsOpen` state, always-render `<SettingsDialog>` in shell, pass
  `settingsOpen` to sidebar, drop Header "Settings" title branch.
- **Modify** `src/components/settings-view.tsx` — drop `PageView` + `onBack`,
  accept `{ open, onOpenChange, requestClose }`, render `DialogContent`-level
  layout (nav + header + scrollable content), keep all state & handlers.
- **Modify** `src/components/settings/shared.ts` — add `icon` to `SETTINGS_TABS`.
- **Modify** `src/components/sidebar.tsx` — `settingsActive={settingsOpen}`.
- **Modify** `src/components/settings/persona-tab.tsx` — add optional
  `onDirtyChange?: (dirty: boolean) => void`.
- **Create** `src/components/settings/__tests__/settings-dialog.test.tsx`.
- **Modify** `src/components/__tests__/settings-view.test.tsx`,
  `embedding-tab.test.tsx`, `nim-settings.test.tsx`.

---

## Detailed Design

### 1. SettingsDialog (`settings-dialog.tsx`)

Renders the Radix `Dialog` shell. `SettingsView` is rendered inside
`DialogContent` so it can attach close-guard handlers to the content element.

```tsx
import { Dialog, DialogContent, DialogOverlay } from "@/components/ui/dialog";
import { SettingsView } from "@/components/settings-view";
import { XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const requestClose = (allow: boolean) => {
    if (allow) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogOverlay />
      <DialogContent
        className={cn(
          // Mobile: fullscreen
          "fixed inset-0 h-dvh w-full max-w-none rounded-none border-0 p-0",
          // Desktop: centered modal
          "md:static md:inset-auto md:max-w-4xl md:w-[calc(100%-2rem)] md:h-[min(720px,85dvh)] md:mx-auto md:rounded-xl",
          "gap-0 p-0 overflow-hidden",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
        )}
        showCloseButton
      >
        {/* Accessible title/description for screen readers */}
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Application settings. Press Escape to close.
        </DialogDescription>

        <SettingsView
          open={open}
          onOpenChange={onOpenChange}
          requestClose={requestClose}
        />
      </DialogContent>
    </Dialog>
  );
}
```

**Note on `requestClose`:** `requestClose` receives the Radix `DialogContent`
event. Actually, `onOpenChange` fires on X/Escape/overlay. The close-guard
handlers (`onEscapeKeyDown`, `onInteractOutside`) are on `DialogContent`. So
`SettingsView` needs to attach those handlers — but `SettingsView` doesn't
render `DialogContent` in this design.

**Revised: close-guard handlers live on `DialogContent` in `settings-dialog.tsx`,
but they need `rebuildBusy` / `isDirty` which live in `SettingsView`.**

Solution: `SettingsView` exposes a **callback ref** or `onBeforeClose` that
`SettingsDialog` calls. Actually the simplest approach: `SettingsView` receives
`requestClose: (canClose: boolean) => void` and calls it when the guard
passes. Radix's `onEscapeKeyDown` and `onInteractOutside` are handled in
`settings-dialog.tsx` by reading a **callback passed down**.

**Final approach — `onBeforeClose` callback:**

`SettingsView` exposes `requestClose: (reason: "escape" | "overlay" | "button") => boolean`
where it checks guards and returns `true` (allow close) or `false` (block). `SettingsDialog`
wires that to `onEscapeKeyDown` / `onInteractOutside`:

```tsx
// settings-dialog.tsx (refined)
function handleEscape(e: KeyboardEvent) {
  const allowed = requestClose("escape");
  if (!allowed) e.preventDefault();
}
```

Wait — but `requestClose` returning false means "show the dirty confirm dialog"
or "block silently for rebuildBusy". For rebuildBusy, block silently. For dirty,
show confirm → if user confirms, close.

**`requestClose` contract (final):**
- Returns `void`.
- Checks `rebuildBusy` first: if true, block (no UI feedback needed — the
  inner Rebuild dialog already prevents Escape/overlay from reaching the outer
  dialog).
- Checks `isDirty`: if true, opens `ConfirmDialog`. If user confirms, calls
  `onOpenChange(false)`. If they cancel, stays open.
- If neither guard triggers, calls `onOpenChange(false)`.

But this means `requestClose` must trigger state in `SettingsView` (the
`ConfirmDialog` is rendered inside `SettingsView`). So `requestClose` is a
`SettingsView` method, called from `settings-dialog.tsx`'s event handlers.

**`SettingsView` exposes `requestClose` via a ref forward, or... simpler:**
Since `SettingsView` renders the content that `DialogContent` wraps, and
`onOpenChange` on the `Dialog` (in `SettingsDialog`) is the primary close path,
let's do this:

- `settings-dialog.tsx` sets `onOpenChange` on the `Dialog` to a function that
  calls `SettingsView`'s guard via a prop: `onRequestClose` which internally
  checks guards and either closes or opens confirm.

```tsx
// SettingsDialog
<Dialog open={open} onOpenChange={(next) => { if (!next) { requestClose() } }}>
```

Where `requestClose` is `SettingsView`'s `requestClose` (handles guards
internally, calls `onOpenChange(false)` when safe). This is the cleanest:
`onOpenChange(false)` fires from Radix for X/Escape/overlay → `SettingsDialog`
calls `requestClose` → `SettingsView` checks guards and decides.

But `SettingsView` can't call `onOpenChange(false)` on the `Dialog` — that would
be circular. Instead, `SettingsView`'s `requestClose` calls the `onOpenChange`
prop it received from `SettingsDialog`, which is the parent's state setter.

**Final clean contract:**

```ts
// SettingsView props
interface SettingsViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;  // parent's setSettingsOpen
  requestClose: () => void;  // SettingsView's guard-checked close
}
```

`SettingsDialog`:
```tsx
function handleOpenChange(next: boolean) {
  if (!next) requestClose();  // SettingsView checks rebuild/dirty, then calls onOpenChange(false)
  else onOpenChange(true);
}
<Dialog open={open} onOpenChange={handleOpenChange}>
```

`SettingsView.requestClose()`:
```ts
const requestClose = () => {
  if (rebuildBusy) return;  // silently blocked; inner rebuild dialog handles this
  if (isDirty || personaDirty) {
    setConfirmDiscardOpen(true);  // opens ConfirmDialog, user decides
    return;
  }
  onOpenChange(false);  // clean close
};
```

This is single-chokepoint, no race conditions, no duplicate handlers.

### 2. SettingsView content layout

`SettingsView`'s root no longer renders `PageView`. It renders:

1. The load error banner (moved from top of PageView to inside the right pane).
2. The section intro paragraph (now in the sticky header instead).
3. The `Tabs` with **responsive orientation**:
   - Mobile (`<768px`): `orientation="horizontal"`, `TabsList` is a horizontal
     scrollable pill bar (`overflow-x-auto`).
   - Desktop (`≥768px`): `orientation="vertical"`, `TabsList` is the left nav
     with icon + label.
4. All `TabsContent` blocks unchanged.
5. All sibling dialogs unchanged (Edit Provider, NimProvider, ModelForm,
   Rebuild confirmation) — rendered after the Tabs, inside the same root.

**Responsive orientation via `useMediaQuery` or `useEffect` + `window.matchMedia`:**

We need to react to viewport changes. Use a `useState` + `useEffect` with
`matchMedia`:

```tsx
const [isMobile, setIsMobile] = useState(() => {
  try { return window.matchMedia("(max-width: 767px)").matches; }
  catch { return false; }
});
useEffect(() => {
  const mq = window.matchMedia("(max-width: 767px)");
  const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}, []);
```

Then `orientation={isMobile ? "horizontal" : "vertical"}` on a single `Tabs`
component.

**Desktop layout (two-pane):**

```tsx
<Tabs orientation={isMobile ? "horizontal" : "vertical"} ...>
  <TabsList className={cn(
    isMobile
      ? "w-full min-w-full flex-row overflow-x-auto"
      : "flex-col w-[232px] h-full min-h-0 gap-1 p-3 border-r bg-muted/40"
  )}>
    {SETTINGS_TABS.map((tab) => (
      <TabsTrigger
        key={tab.value}
        value={tab.value}
        className={cn(
          "h-9 rounded-md",
          isMobile ? "px-3" : "justify-start px-3 gap-2"
        )}
      >
        <tab.icon className="size-4 shrink-0" />
        {tab.label}
      </TabsTrigger>
    ))}
  </TabsList>

  {/* Desktop: right pane with sticky header + scrollable content */}
  {!isMobile && (
    <>
      <div className="sticky top-0 shrink-0 border-b bg-popover px-6 py-4 z-10">
        <h2 className="text-lg font-semibold">
          {SETTINGS_TABS.find(t => t.value === activeTab)?.label}
        </h2>
        <p className="text-muted-foreground text-xs mt-0.5">
          {SETTINGS_TAB_INTROS[activeTab]}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable] px-6 py-4 min-h-0">
        {loadError && <ErrorBanner />}
        <TabsContent value="general"><GeneralTab /></TabsContent>
        ...etc...
      </div>
    </>
  )}

  {/* Mobile: intro + content stacked, no sticky header */}
  {isMobile && (
    <div className="px-4 py-3 min-h-0 overflow-y-auto">
      <p className="text-muted-foreground text-xs mb-3">
        {SETTINGS_TAB_INTROS[activeTab]}
      </p>
      {loadError && <ErrorBanner />}
      <TabsContent value="general"><GeneralTab /></TabsContent>
      ...etc...
    </div>
  )}
</Tabs>
```

Hmm — `TabsContent` inside `Tabs` — but we're splitting the layout into two
branches. `TabsContent` must be a direct child of `Tabs` (or within its tree).
The conditional rendering works as long as all `TabsContent`s are inside the
`Tabs` component. But the desktop/mobile split means we render different
wrappers around `TabsContent` in each branch.

**Simpler approach:** always render the same `TabsContent`s, just change the
layout wrapper:

```tsx
<Tabs orientation={isMobile ? "horizontal" : "vertical"} value={activeTab} onValueChange={...}>
  <TabsList className={cn(...) }>
    {SETTINGS_TABS.map(...)}
  </TabsList>

  {!isMobile && (
    <div className="flex flex-col flex-1 min-w-0">
      <div className="sticky top-0 shrink-0 border-b ...">
        <h2>...</h2>
        <p>{SETTINGS_TAB_INTROS[activeTab]}</p>
      </div>
      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable] px-6 py-4">
        {loadError && <ErrorBanner />}
        <TabsContent value="general"><GeneralTab /></TabsContent>
        <TabsContent value="persona"><PersonaTab .../></TabsContent>
        ...
      </div>
    </div>
  )}

  {isMobile && (
    <div className="px-4 py-3 overflow-y-auto">
      <p className="text-muted-foreground text-xs mb-3">
        {SETTINGS_TAB_INTROS[activeTab]}
      </p>
      {loadError && <ErrorBanner />}
      <TabsContent value="general"><GeneralTab /></TabsContent>
      <TabsContent value="persona"><PersonaTab .../></TabsContent>
      ...
    </div>
  )}
</Tabs>
```

This duplicates the `TabsContent` list (once per branch). That's repetitive but
keeps the layout conditional clean. To avoid duplication, extract a helper
component `SettingsTabContents` that renders all `TabsContent` blocks.

Actually, `TabsContent` is display-controlled by the `Tabs` value — it renders
its children but hides inactive ones. So we can render them once in either
branch; they're controlled by the shared `activeTab`/`value`. Let me
consolidate: render the `TabsContent`s once, outside the isMobile branches,
and only branch on the nav + header layout:

```tsx
<Tabs orientation={...} value={activeTab} onValueChange={...}>
  <TabsList className={cn(...) }>
    {SETTINGS_TABS.map(...)}
  </TabsList>

  {!isMobile && (
    <div className="sticky top-0 ... z-10 border-b px-6 py-3">
      <h2>{activeLabel}</h2>
      <p>{SETTINGS_TAB_INTROS[activeTab]}</p>
    </div>
  )}
  {isMobile && (
    <p className="text-muted-foreground text-xs px-4 py-2 mb-2">
      {SETTINGS_TAB_INTROS[activeTab]}
    </p>
  )}

  <div className={cn("overflow-y-auto [scrollbar-gutter:stable]", isMobile ? "px-4 py-3" : "flex-1 px-6 py-4")}>
    {loadError && <ErrorBanner />}
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

{/* Sibling dialogs — always render inside SettingsView root, after Tabs */}
<Dialog ...> {/* Edit Provider */}
{/* NimProviderDialog */}
{/* ModelForm */}
{/* Rebuild confirmation Dialog */}
```

This works! The `TabsContent`s are inside `Tabs`, controlled by `value`. The
scrollable container wraps them. The sticky header / intro paragraph branch
only. The sibling dialogs render as children of the `SettingsView` root (which
is inside `DialogContent`).

### 3. SETTINGS_TABS with icons (`shared.ts`)

Add `icon` field. Type-safe approach to avoid `as const` issues with component
references:

```ts
import type { ComponentType } from "react";
import { Gear, UserCircle, Plugs, Cpu, Funnel, Database, Wrench, Info } from "@phosphor-icons/react";

type TabIcon = ComponentType<{ className?: string }>;

export const SETTINGS_TABS: Array<{
  value: string;
  label: string;
  icon: TabIcon;
}> = [
  { value: "general", label: "General", icon: Gear },
  { value: "persona", label: "Persona", icon: UserCircle },
  { value: "provider", label: "Providers", icon: Plugs },
  { value: "embedding", label: "Embedding", icon: Cpu },
  { value: "reranker", label: "Reranker", icon: Funnel },
  { value: "database", label: "Database", icon: Database },
  { value: "tools", label: "Tools", icon: Wrench },
  { value: "about", label: "About", icon: Info },
];

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];
```

Changing from `as const` to an explicit `Array<...>` type. The `SettingsTab`
type derivation: `(typeof SETTINGS_TABS)[number]["value"]` = `string` (broader
than the literal union `"general" | "persona" | ...`).

**Impact:** `activeTab: SettingsTab` was previously a string-literal union.
With `string`, `setActiveTab(value as SettingsTab)` still works, but
`SETTINGS_TAB_INTROS[activeTab]` with `activeTab: string` would fail since
`SETTINGS_TAB_INTROS` is keyed by `SettingsTab`.

**Fix:** Keep the literal union by deriving from the values:

```ts
export const SETTINGS_TABS = [
  { value: "general", label: "General", icon: Gear },
  { value: "persona", label: "Persona", icon: UserCircle },
  ...
] as const satisfies ReadonlyArray<{ value: string; label: string; icon: TabIcon }>;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];
```

The `satisfies` keeps the literal types inferred (`"general" | "persona" | ...`)
while validating the shape. This is the cleanest — backward-compatible with all
existing `SettingsTab` usage and `SETTINGS_TAB_INTROS`.

### 4. Close-guard logic

```tsx
// Inside SettingsView, alongside existing state:
const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

// Derived dirty state — compares current form values against the server snapshot.
const isDirty = useMemo(() => {
  if (!settings) return false;

  // 1. Add-provider form
  if (openaiFormOpen && (oaName.trim() || oaBaseUrl.trim() || oaApiKey.trim())) {
    return true;
  }

  // 2. Embedding changes
  if (settings.embedding) {
    if (embApiKey.trim()) return true;
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

  // 3. Web search form changes
  const wsSnapshot = webSearchFormFromEntries(
    settings.store?.websearch?.providers?.length
      ? settings.store.websearch.providers
      : settings.webSearch?.providers ?? []
  );
  for (const kind of Object.keys(wsForm) as WebSearchProviderKind[]) {
    if (wsForm[kind].enabled !== wsSnapshot[kind].enabled) return true;
    if (wsForm[kind].apiKey !== wsSnapshot[kind].apiKey) return true;
    if (wsForm[kind].baseUrl !== wsSnapshot[kind].baseUrl) return true;
  }

  return false;
}, [
  settings, openaiFormOpen, oaName, oaBaseUrl, oaApiKey,
  embApiKey, embProviderId, embOnnxModelPath, embBaseUrl, embModel, embDimensions,
  wsForm,
]);

// PersonaTab reports via callback
const [personaDirty, setPersonaDirty] = useState(false);
// Pass to PersonaTab: onDirtyChange={setPersonaDirty}

const requestClose = useCallback(() => {
  // Block during SSE rebuild — Radix won't close because the inner
  // "Rebuild embeddings?" dialog intercepts Escape/overlay while rebuildBusy.
  if (rebuildBusy) return;

  if (isDirty || personaDirty) {
    setConfirmDiscardOpen(true);
    return;
  }
  onOpenChange(false);
}, [rebuildBusy, isDirty, personaDirty, onOpenChange]);

const confirmAndClose = () => {
  setConfirmDiscardOpen(false);
  onOpenChange(false);
};
```

The `ConfirmDialog` for discarding:

```tsx
<ConfirmDialog
  open={confirmDiscardOpen}
  onOpenChange={setConfirmDiscardOpen}
  title="Unsaved changes"
  description="You have unsaved changes. Are you sure you want to close? They will be lost."
  confirmLabel="Discard"
  cancelLabel="Keep editing"
  onConfirm={confirmAndClose}
/>
```

### 5. page.tsx changes

```diff
  const [view, setView] = useState<
-   | "chat" | "projects" | "cron" | "subagents"
-   | "settings" | "mcp" | "skills" | "plugins" | "statistics"
+   | "chat" | "projects" | "cron" | "subagents"
+   | "mcp" | "skills" | "plugins" | "statistics"
  >("chat");
+ const [settingsOpen, setSettingsOpen] = useState(false);

  const handleOpenSettings = () => {
-   setView("settings");
+   setSettingsOpen(true);
    closeSidebarOnMobile();
  };
- const handleCloseSettings = () => setView("chat");

  // In render — always mount SettingsDialog (Radix portals cost nothing when closed):
+ <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

  // Remove: {view === "settings" && <SettingsView onBack={handleCloseSettings} />}

  // Header chatTitle: remove the `view === "settings"` branch
  isChatView={view === "chat"}

  // Sidebar:
  settingsActive={settingsOpen}  // visual-only; aria-hidden while modal open
```

ChatArea's `view !== "chat" && "hidden"` — with `view` always `"chat"` when
settings is open, ChatArea stays visible behind the overlay. ✓

### 6. Test contract

**Outer dialog accessible name:** "Settings" (visually hidden `DialogTitle`).

**Test selectors (explicit everywhere):**
- Outer modal: `getByRole("dialog", { name: /Settings/i })`
- Rebuild confirmation: `getByRole("dialog", { name: /Rebuild embeddings/i })`
- Edit Provider: `getByRole("dialog", { name: /Edit Provider/i })`
- ModelForm: `getByRole("dialog", { name: /Add Model|Edit Model/i })`

**Existing test files updated:**
- `settings-view.test.tsx`: `render(<SettingsView open={true} onOpenChange={jest.fn()} requestClose={jest.fn()} />)`.
  Wait — tests will break if `SettingsView` now requires `requestClose`.
  **Fix:** `requestClose` is optional or tests use `SettingsDialog` wrapper.
  Better: tests render `<SettingsDialog open={true} onOpenChange={jest.fn()} />`
  which internally renders `SettingsView`. That's the real component boundary.

  But tests currently import `SettingsView` directly. Change them to import
  `SettingsDialog` from `@/components/settings/settings-dialog`. The test
  renders `<SettingsDialog open={true} onOpenChange={fn} />` and the full
  Radix dialog tree is in the DOM.

  Problem: Tests that mock `/api/settings` fetch expect the snapshot to load.
  `SettingsView` fetches on mount — that still happens inside the Dialog. The
  fetch effect fires when `SettingsView` mounts, which is when the Dialog opens.
  ✓

  For tests that need to assert "content not rendered when closed": render with
  `open={false}` and verify `getByRole("tab", { name: "General" })` is not in
  the document. ✓

- `embedding-tab.test.tsx`: currently renders `<SettingsView onBack={...} />`.
  Update to `<SettingsDialog open={true} onOpenChange={fn} />`.

- `nim-settings.test.tsx`: same — renders `SettingsView`, switch to
  `SettingsDialog`.

**`settings-dialog.test.tsx` (new):**
- Renders with `open={true}` → sees General tab content, tab list with all 8.
- Clicks nav items → `activeTab` switches, content changes.
- `open={false}` → no dialog, no tab content.
- Escape (when dirty) → confirm dialog appears. When clean → `onOpenChange(false)` called.
- X button → same as Escape.
- Rebuild in progress → Escape blocked (inner rebuild dialog intercepts).

### 7. PersonaTab `onDirtyChange`

In `PersonaTab`, the local state `name` / `instructions` differs from props
`persona.name` / `persona.instructions` until saved. Compute:

```tsx
const PersonaTab = ({ persona, defaultPersona, onSave, onReset, onDirtyChange }) => {
  const [name, setName] = useState(persona.name ?? "");
  const [instructions, setInstructions] = useState(persona.instructions ?? "");

  useEffect(() => {
    const dirty = name !== persona.name || instructions !== persona.instructions;
    onDirtyChange?.(dirty);
  }, [name, instructions, persona, onDirtyChange]);

  // existing useEffect that resets name/instructions on persona change
  // (keeps onDirtyChange accurate across snapshot reloads)
```

Existing `persona-settings-tab.test.tsx` renders `<PersonaTab>` directly —
`onDirtyChange` is optional, so no changes needed there. ✓

---

## Summary of Architecture Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Who owns `<Dialog>` | `SettingsDialog` | Task explicitly requires the component; keeps `page.tsx` clean. |
| Who owns `<DialogContent>` | `SettingsDialog` | `DialogContent` is part of the Dialog primitive. `SettingsView` renders its children inside. |
| Close-guard location | `SettingsView.requestClose` | Needs access to `rebuildBusy`, `isDirty`, `personaDirty`. |
| Close-guard wiring | `Dialog.onOpenChange` → `requestClose` | Single chokepoint; Radix fires `onOpenChange(false)` for X/Escape/overlay. |
| Mobile layout | Single `Tabs` with responsive `orientation` | No duplicate DOM tree; `matchMedia` drives `isMobile`. |
| Dirty tracking | Derived `useMemo` + PersonaTab callback | Avoids hydration-trips and cross-tab false negatives. |
| Rebuild-blocking | Inherent (inner dialog intercepts) + belt-and-suspenders `rebuildBusy` check in `requestClose` | Defense in depth. |
