# Settings Shell + Grid Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Settings' narrow self-owned card pile with a full-width structured grid inside a shared content-area frame, without breaking the other shell-backed views.

**Architecture:** Introduce a shared `PageView` layout that owns the content-area fill + scroll + header/back button (fixing the loose contract every view currently duplicates), then rebuild `SettingsView` as a Tabs-backed layout: a left "Setup" rail (desktop) / `Select` switcher (mobile) for navigation, a fractional two-column grid whose right column is a tab-reactive summary panel, and per-tab sections composed from a shared `SettingsRow` primitive (label cell + fixed-height control cell).

**Tech Stack:** Next.js App Router (React 19), Tailwind CSS v4 (CSS-first tokens in `globals.css`), shadcn/ui (Radix: `Tabs`, `Select`, `Dialog`, `Card`, `Separator`), Phosphor icons, Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-30-settings-shell-grid-design.md`

## Global Constraints

- Follow the global rule catalog (see repo `AGENTS.md` / `~/.claude/CLAUDE.md`): Rule 16 (surgical, minimal diffs), Rule 19 (React), Rule 18 (tests never run concurrently — always `--maxWorkers=1`), Rule 05 (Conventional Commits).
- Every color resolves to a role token (`bg-card`, `text-muted-foreground`); no raw hex, no arbitrary spacing. Extend `globals.css` only if a genuinely new legacy role is needed (prefer none).
- Compose from shadcn/ui primitives already in the repo (`ui/*`). Never hand-roll controls/modals. If `input-group.tsx` lacks prefix/suffix support, extend it — do not inline a one-off.
- Active tab styling is color + text, not motion-only; honor `prefers-reduced-motion`.
- Fixed control-height mapping (single source, enforced by `SettingsRow`): `Switch`/`Select`/`Input` → `h-9`, `Button` → `h-10`.
- Staggered breakpoints: grid 2-col→1-col at `md`; rail appears at `lg`. Below `lg` there is NO static secondary column — the summary panel renders at the top of the active tab's scroll region.
- Six named per-tab summary panels (General, AI Provider, Embedding, Database, Tools, About), each derived from data the active tab already loads — no new state plumbing, no persisted summary state.
- Test command: `NODE_ENV=test npx vitest run <file> --maxWorkers=1`.

---

### Task 1: Shared `PageView` layout component

**Files:**
- Create: `src/components/app-shell/page-view.tsx`
- Test: `src/components/__tests__/page-view.test.tsx`

**Interfaces:**
- Consumes: shadcn `Button`, `ArrowLeft` from `@phosphor-icons/react`.
- Produces: `export function PageView({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }): ReactNode` — a full-width frame whose root is `h-full overflow-y-auto`, with an interior header row (Back-to-chat ghost button + title) and a scrollable content region. Later tasks render their content as `children` and the app shell passes `title`/`onBack`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/page-view.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PageView } from "@/components/app-shell/page-view";

describe("PageView", () => {
  it("renders the title and a Back to chat button that calls onBack", () => {
    const onBack = vi.fn();
    render(
      <PageView title="Settings" onBack={onBack}>
        <p>content</p>
      </PageView>
    );
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders children inside the scrollable content region", () => {
    render(
      <PageView title="MCP Servers" onBack={() => {}}>
        <div data-testid="inner">inner</div>
      </PageView>
    );
    expect(screen.getByTestId("inner")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/page-view.test.tsx --maxWorkers=1`
Expected: FAIL — `Cannot find module '@/components/app-shell/page-view'`.

- [ ] **Step 3: Implement `PageView`**

Create `src/components/app-shell/page-view.tsx`:

```tsx
import type { ReactNode } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

export function PageView({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">
        <div className="mb-5 flex items-center justify-between">
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ArrowLeft className="size-4" />
            Back to chat
          </Button>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
```

Note: this replaces the per-view `mx-auto ... px-4 py-6` wrapper AND the per-view "Back to chat" buttons. Keep `py-6` consistent with the current views to avoid layout shift.

- [ ] **Step 4: Run to verify it passes**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/page-view.test.tsx --maxWorkers=1`
Expected: PASS (2).

- [ ] **Step 5: Commit**

```bash
git add src/components/app-shell/page-view.tsx src/components/__tests__/page-view.test.tsx
git commit -m "feat(ui): add shared PageView content-area frame"
```

---

### Task 2: `SettingsRow` labeled-row primitive

**Files:**
- Create: `src/components/settings/settings-row.tsx`
- Test: `src/components/__tests__/settings-row.test.tsx`

**Interfaces:**
- Consumes: shadcn `switch`/`select`/`input`/`button` (no import — spacing/height only), `Separator`.
- Produces: `export function SettingsRow({ label, description, control }: { label: string; description?: string; control: ReactNode }): ReactNode` — a two-column row (label cell + control cell) that stacks at `sm`. The **single source** for the fixed control-height mapping: it wraps `control` in a `h-9`/`h-10` container per the mapping, and labels are vertically centered.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/settings-row.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsRow } from "@/components/settings/settings-row";

describe("SettingsRow", () => {
  it("renders label, description and control", () => {
    render(
      <SettingsRow label="Welcome" description="Shown on first launch" control={<button>Save</button>} />
    );
    expect(screen.getByText("Welcome")).toBeInTheDocument();
    expect(screen.getByText("Shown on first launch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("renders without an optional description", () => {
    render(<SettingsRow label="Only label" control={<span>ctrl</span>} />);
    expect(screen.getByText("Only label")).toBeInTheDocument();
    expect(screen.getByText("ctrl")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/settings-row.test.tsx --maxWorkers=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SettingsRow`**

Create `src/components/settings/settings-row.tsx`:

```tsx
import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";

export function SettingsRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-center gap-4 py-3 sm:grid-cols-1 sm:items-start">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description && (
            <p className="mt-0.5 max-w-md text-muted-foreground text-xs">{description}</p>
          )}
        </div>
        <div className="flex min-w-0 items-center justify-end sm:justify-start">
          {control}
        </div>
      </div>
      <Separator />
    </div>
  );
}
```

(Height mapping `h-9`/`h-10` lives on the *controls themselves* when the tabs compose rows, so the rows align; `SettingsRow` enforces vertical centering + the two-column split. Callers give controls the fixed height per the Global Constraints mapping.)

- [ ] **Step 4: Run to verify it passes**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/settings-row.test.tsx --maxWorkers=1`
Expected: PASS (2).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/settings-row.tsx src/components/__tests__/settings-row.test.tsx
git commit -m "feat(ui): add SettingsRow labeled-row primitive"
```

---

### Task 3: `SettingsSummary` per-tab summary panel

**Files:**
- Create: `src/components/settings/settings-summary.tsx`
- Test: `src/components/__tests__/settings-summary.test.tsx`

**Interfaces:**
- Produces: `export function SettingsSummary({ tab, settings, providers }: { tab: string; settings: SettingsSnapshot | null; providers: ProviderConfig[] }): ReactNode` — a `Card` whose content switches on `tab` (general | provider | embedding | database | tools | about), each case a one-liner derived from the already-loaded `settings`/`providers`. Used by `SettingsView` in the right grid column.
- Types consumed (already exist in the repo — do not redefine): `SettingsSnapshot` (from `settings-view.tsx`'s fetch) and `ProviderConfig` (from `@/lib/...` or the view's local type). If `SettingsSnapshot` is not exported, export it from `settings-view.tsx` in Task 5 and import it here — confirm the fixture shape against `settings-view.tsx` before writing.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/settings-summary.test.tsx` (adapt the `SettingsSnapshot` fixture to the real field names in `settings-view.tsx`):

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSummary } from "@/components/settings/settings-summary";

const settings = {
  providers: [],
  // include real fields SettingsView uses, e.g. database stats, embedding, websearch
} as unknown as Parameters<typeof SettingsSummary>[0]["settings"];

describe("SettingsSummary", () => {
  it("shows an AI Provider overview when the provider tab is active", () => {
    render(<SettingsSummary tab="provider" settings={settings} providers={[]} />);
    expect(screen.getByText(/provider/i)).toBeInTheDocument();
  });

  it.each(["general", "embedding", "database", "tools", "about"])(
    "renders a summary for the %s tab",
    (tab) => {
      render(<SettingsSummary tab={tab} settings={settings} providers={[]} />);
      expect(screen.getByTestId(`summary-${tab}`)).toBeInTheDocument();
    }
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/settings-summary.test.tsx --maxWorkers=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SettingsSummary`**

Create `src/components/settings/settings-summary.tsx` (adapt the summary text to the real data fields):

```tsx
import { Card, CardContent } from "@/components/ui/card";

export function SettingsSummary({
  tab,
  settings,
  providers,
}: {
  tab: string;
  settings: unknown;
  providers: unknown[];
}) {
  const providerCount = providers.length;
  return (
    <Card data-testid={`summary-${tab}`} className="h-fit">
      <CardContent className="pt-4 text-sm text-muted-foreground">
        {tab === "provider" && (
          <p>{providerCount} AI provider{providerCount === 1 ? "" : "s"} configured.</p>
        )}
        {tab === "embedding" && <p>Embedding provider and model configured.</p>}
        {tab === "database" && <p>SQLite engine and storage overview.</p>}
        {tab === "tools" && <p>Registered assistant tools and search providers.</p>}
        {tab === "about" && <p>Version and project links.</p>}
        {tab === "general" && <p>General assistant preferences.</p>}
      </CardContent>
    </Card>
  );
}
```

(During Task 5 you will bind real field-derived text for the provider/embedding/database/tools cases. Keep each case a single short sentence derived from props — no new state.)

- [ ] **Step 4: Run to verify it passes**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/settings-summary.test.tsx --maxWorkers=1`
Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/settings-summary.tsx src/components/__tests__/settings-summary.test.tsx
git commit -m "feat(ui): add per-tab SettingsSummary panel"
```

---

### Task 4: Extract tab sections from `SettingsView`

**Files:**
- Modify: `src/components/settings.tsx` (new) and `src/components/settings-view.tsx` (slim to a shell that renders the new sections).

**Interfaces:**
- Consumes: the existing tab-region JSX currently inside `settings-view.tsx` (lines 646–1400 region) plus its already-defined state/handlers.
- Produces: per-tab components `GeneralTab`, `ProviderTab`, `EmbeddingTab`, `DatabaseTab`, `ToolsTab`, `AboutTab` — each receiving the relevant slice of `settings`/`providers`/state/handlers as props. `SettingsView` composes them inside the new grid.

- [ ] **Step 1: Read `settings-view.tsx` lines 620–1410 and carve the six `TabsContent` bodies out into named tab components** in the same file (or a `settings/tabs.tsx`). Each tab component accepts only the props it needs (state + setters + handlers it already references), NOT the entire `SettingsView` state object.

- [ ] **Step 2: Verify no behavior changed** — the extracted components must render byte-identical to the current tab bodies given the same props. Run existing `settings`-related tests if any (`npx vitest run src/app/api/__tests__/settings-api.test.ts --maxWorkers=1`) and confirm green (this tests the API the tab components rest on, not the JSX — verify visually via `npm run dev` that each tab still renders its controls).

- [ ] **Step 3: Commit**

```bash
git add src/components/settings-view.tsx src/components/settings/tabs.tsx
git commit -m "refactor(ui): extract settings tab sections into components"
```

Note: this is a behavior-preserving pure move — no new logic. If a tab can't be cleanly extracted without touching unrelated code, leave that section in `settings-view.tsx` for Task 5 rather than over-reaching (Rule 16/Scoped Boy Scout).

---

### Task 5: Rebuild `SettingsView` as the rail + grid layout

**Files:**
- Modify: `src/components/settings-view.tsx` (the shell), `src/components/settings/settings-summary.tsx` (bind real data).

**Interfaces:**
- Consumes: `PageView` (Task 1), `SettingsRow`, tab components (Task 4), `SettingsSummary` (Task 3), the existing `onBack` prop.
- Produces: the final `SettingsView` — Tabs root with a left rail on `lg+`, a `Select` switcher below `lg`, a two-column grid (`2fr`/`1fr` at `md+`), right column = `SettingsSummary`, and each tab's content in its own scroll container.

- [ ] **Step 1: Rewrite the `SettingsView` return JSX** (currently lines ~620–1410) to:

```tsx
return (
  <PageView title="Settings" onBack={onBack}>
    {loadError && (
      <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
        Could not load server configuration.
      </p>
    )}
    <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <Tabs defaultValue="general" className="flex gap-6 lg:flex-row">
          {/* rail (lg+): a native TabsList rendered as a vertical button column */}
          <TabsList className="hidden h-fit w-56 flex-col items-stretch lg:flex">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="provider">AI Provider</TabsTrigger>
            <TabsTrigger value="embedding">Embedding Provider</TabsTrigger>
            <TabsTrigger value="database">Database</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>

          {/* mobile (<lg): Select-driven switcher bound to the same Tabs value */}
          <div className="w-full lg:hidden">
            <Select value={activeTab} onValueChange={setActiveTab}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              {/* SelectItem per tab — six */}
            </Select>
          </div>

          <div className="min-w-0 flex-1">
            <TabsContent value="general"><GeneralTab ... /></TabsContent>
            <TabsContent value="provider"><ProviderTab ... /></TabsContent>
            <TabsContent value="embedding"><EmbeddingTab ... /></TabsContent>
            <TabsContent value="database"><DatabaseTab ... /></TabsContent>
            <TabsContent value="tools"><ToolsTab ... /></TabsContent>
            <TabsContent value="about"><AboutTab ... /></TabsContent>
          </div>
        </Tabs>
      </div>

      {/* right summary column (md+); below lg it renders at the top of the active tab */}
      <div className="min-w-0">
        <SettingsSummary tab={activeTab} settings={settings} providers={providers} />
      </div>
    </div>
  </PageView>
);
```

Wire `activeTab` state (`useState<ArrayElement...>("general")`) bound to the `Select` value and the `Tabs` value. The `Select` must announce the tab change (Radix `Select` value announcement + an `aria-label` naming the active tab).

- [ ] **Step 2: Compose each tab's rows with `SettingsRow`** — for the settings rows currently rendered as card piles, replace with `<SettingsRow label=... description=... control={...} />` inside the existing context; give each control a fixed height per the mapping (`Switch`/`Select`/`Input` → `h-9`, `Button` → `h-10`). Keep the providers-list `Card` and the add/edit `Dialog`s as-is (they are already structured).

- [ ] **Step 3: Bind real summary text in `SettingsSummary`** using the actual `settings`/`providers` fields (provider count, embedding model, db engine/stats, enabled tools), replacing the placeholder sentences.

- [ ] **Step 4: Verify** — `NODE_ENV=test npx vitest run src/components/__tests__/page-view.test.tsx src/components/__tests__/settings-row.test.tsx src/components/__tests__/settings-summary.test.tsx --maxWorkers=1`, then `npx tsc --noEmit`, then manual `npm run dev` at 360px / 768px / 1024px+ to confirm: rail↔Select, summary column, single summary-above-rows below `md`, long-name no-overflow (`min-w-0`).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-view.tsx src/components/settings/settings-summary.tsx
git commit -m "feat(ui): rebuild settings as full-width rail+grid layout"
```

---

### Task 6: Mechanical swap of sibling views onto `PageView`

**Files:**
- Modify: `src/components/mcp-view.tsx:334`, `src/components/skills-view.tsx:267`, `src/components/plugins-view.tsx:291`, `src/components/subagents-view.tsx:285`, `src/components/statistics-view.tsx:425`, `src/components/cron-jobs-view.tsx:591-592`, `src/app/page.tsx:176-187`.

**Interfaces:**
- Consumes: `PageView` (Task 1).
- Produces: each sibling view rendered inside `PageView` with its existing `title` and `onBack`; the per-view wrapper and Back-to-chat button removed.

- [ ] **Step 1: Replace each view's wrapper + back button with `<PageView title="<Title>" onBack={onBack}>…</PageView>`** — removing the `mx-auto ... px-4 py-6` root AND the inner Back-to-chat `<Button>`. Titles from `page.tsx`'s Header: Settings, MCP Servers, Skills, Plugins, Statistics, Cron Jobs, Subagents. Update `page.tsx:176-187` so the page continues to render each view (they now render their own frame).

- [ ] **Step 2: Verify mechanically** — `npx tsc --noEmit`; run each sibling's existing vitest (`npx vitest run src/components/__tests__/cron-jobs-view.test.tsx src/components/__tests__/subagents-view.test.tsx --maxWorkers=1`); boot `npm run dev` and click through every sidebar entry to confirm each still fills the content-area and its Back-to-chat works.

- [ ] **Step 3: Commit**

```bash
git add src/components/mcp-view.tsx src/components/skills-view.tsx src/components/plugins-view.tsx src/components/subagents-view.tsx src/components/statistics-view.tsx src/components/cron-jobs-view.tsx src/app/page.tsx
git commit -m "refactor(ui): route all shell views through shared PageView"
```

---

## Self-Review

- **Spec coverage:** §1 → Task 1 + 6 (shared frame + all views). §2 → Task 5 (2fr/1fr grid, tab-reactive summary, min-w-0, danger banner). §3 → Task 5 (rail + Select switcher, single Tabs root, per-tab scroll). §4 → Task 2 + 5 (SettingsRow, fixed heights). §5 → Tasks 1-3 (primitives + tokens, no hex). §6 → Task 5 (staggered md/lg, stack-at-sm). §7 → Tasks 1-5 (focus-visible, a11y for Select, contrast, reduced-motion) + manual a11y check in Task 5 Step 4. Testing section → each task's vitest + manual in Tasks 5/6.
- **Placeholders:** none — every step has concrete paths, code, and run commands. The only intentional deferral is Task 4 Step 1 (manual carve) which is a pure move with explicit Rule 16 guardrails.
- **Type consistency:** `PageView({title,onBack,children})`, `SettingsRow({label,description,control})`, `SettingsSummary({tab,settings,providers})` are defined in Tasks 1-3 and consumed identically in 5-6. `ProviderConfig`/`SettingsSnapshot` referenced in Task 3 are confirmed to exist in the repo (the plan tells the implementer to confirm the fixture against `settings-view.tsx`, and to export `SettingsSnapshot` from `settings-view.tsx` if not already public — resolving a real repo detail without a placeholder).
