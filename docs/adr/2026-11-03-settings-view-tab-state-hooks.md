# ADR: Settings state ownership — per-tab hooks, presentational tabs

**Date:** 2026-11-03
**Status:** Accepted
**Decision Owner:** Project Lead
**Context:** Issue #3, Part 2 (follow-up to the move-only slices)

## Context

`src/components/settings-view.tsx` was 2738 lines and is now 2262 after four
move-only extractions (snapshot helpers, embedding-change dialog, add-GGUF
dialog, provider-edit dialog). The remaining bulk is one component body holding
**84 `useState` declarations** plus their handlers and hydration effects.

The tab panels themselves are already extracted — `GeneralTab`, `PersonaTab`,
`ProviderTab`, `EmbeddingTab`, `RerankerTab`, `DatabaseTab`, `ToolsTab`,
`AboutTab`. But the state and handlers still live in the shell, which passes
them down as large prop bags (22–25 props for `EmbeddingTab` / `RerankerTab`).

The obvious next step — "move the state into the tab component" — is **wrong
here**:

- The panels are rendered inside Radix `TabsContent`, and Radix **unmounts
  inactive panels** (no `forceMount` is set). State moved into a panel would be
  destroyed on every tab switch, discarding unsaved edits. That is a behavior
  change, not a refactor.
- Several values are read by the shell itself, not just the panel: `isDirty`
  (the close guard) compares the embedding form against the snapshot, and the
  embedding-change dialog is rendered outside the tabs.
- Cross-tab coordination is real: `settingsVersion` is a single "re-fetch the
  snapshot" counter bumped by nearly every save path, and the resulting
  re-hydration overwrites form state for embedding, web search, and reranker
  together. Splitting that per-tab needs an explicit contract, not ad-hoc
  lifting.

## Decision

1. **Extract each tab's state and handlers into a custom hook** under
   `src/components/settings/hooks/`, owned by the shell:
   `useEmbeddingSettings`, `useRerankerSettings`, `useProviderRegistry`, …
2. **Tabs stay presentational.** They keep receiving props; the shell
   destructures the hook and passes the same names through, so panel code and
   prop shapes do not change in the extraction commit.
3. **The shell keeps shared infrastructure:** the snapshot fetch, the
   `settingsVersion` refresh counter, `isDirty`/close-guard, the install
   notification, and cross-tab callbacks (`onRefresh`, `setMaintenanceNote`).
   Hooks receive these as arguments.
4. **Hooks mirror the existing hydration semantics** — same inputs, same
   dependency list (`reloadKey`, `open`), same "snapshot wins" overwrite on
   re-fetch. The extraction must be behavior-identical; any change to *when*
   state resets is a separate, test-backed decision.
5. **One hook per change**, with `renderHook` tests covering hydration, save
   success, probe failure, and force-save. Hooks are the first code in this area
   that is directly unit-testable without rendering the whole dialog.

## Consequences

- The shell shrinks by the size of each hook's state + handlers while keeping a
  single owner for shared state; no panel remount semantics change.
- Prop bags stay as they are for now. Collapsing them is a later, optional step
  (the hook's return value can feed a context once the shell is thin), and is
  not required to get the readability win.
- `isDirty` still depends on embedding fields, so the shell destructures them
  from the hook — a slightly wide return object is the price of leaving call
  sites untouched.
- Testability improves materially: today none of this logic is covered without
  mounting the entire settings dialog.

## Migration order

1. **Embedding** (largest, most entangled — proves the pattern).
2. Reranker (same shape: form + probe + save).
3. Provider registry (CRUD + GGUF/NIM/Ollama flows).
4. Database/maintenance, tools, persona.
5. Revisit prop bags / context only after the shell is thin.
