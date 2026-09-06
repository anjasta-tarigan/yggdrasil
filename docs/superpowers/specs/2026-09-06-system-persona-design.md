# Design Specification: Global System Persona Subsystem

**Date:** 2026-09-06  
**Status:** Approved  
**Topic:** Global System Persona Customization with High-Efficiency Prompt Caching  

---

## 1. Overview & Objectives

### 1.1 Goal
Provide a unified, efficient, and user-customizable **System Persona** subsystem for Yggdrasil. Users can define global custom identity, tone, and behavioral instructions in Settings that apply across all chat sessions, while ensuring maximum LLM prompt-cache hit rates and preserving critical tool execution invariants.

### 1.2 Core Requirements
- **Single Global Persona**: Configured once in Settings and applied to all conversations (no complex per-chat overrides or avatar bloat).
- **Free-Form System Instructions**: A flexible markdown-compatible instruction field allowing custom personality, role, tone, and formatting constraints.
- **Maximum Cache Efficiency**: Instructions are placed at the static prefix of the system prompt (Layer 1) to maximize LLM prompt-cache hits across turns.
- **Core Invariant Preservation**: System tool invariants (`artifact_publish`, `web_search`, `task_list_manager`, `ask_user_question`) are automatically appended after the custom persona so tool calling cannot be broken by user configuration.
- **Reset to Default**: Quick recovery to Yggdrasil default behavior with a single click.

---

## 2. Architecture & Data Model

### 2.1 Storage Schema
The system persona configuration is stored in the existing SQLite `settings` table under the key `"system_persona"`.

#### TypeScript Interfaces & Defaults (`src/lib/persona/types.ts`)
```typescript
export interface SystemPersonaConfig {
  /** Optional custom persona name/label, e.g. "Software Architect" */
  name?: string;
  /**
   * The custom system instructions/behavioral prompt.
   * If empty string or undefined, falls back to DEFAULT_SYSTEM_PERSONA.instructions.
   */
  instructions: string;
  /** Timestamp when the persona was last updated */
  updatedAt: number;
}

export const DEFAULT_SYSTEM_PERSONA: SystemPersonaConfig = {
  name: "Yggdrasil",
  instructions:
    "You are Yggdrasil, an intelligent and proactive personal AI assistant. You are concise, direct, and capable.",
  updatedAt: 0,
};
```

### 2.2 Service Layer (`src/lib/persona-service.ts`)
Encapsulates CRUD operations, Zod validation, and in-memory caching:
- `getSystemPersona(db?: AppDatabase): Promise<SystemPersonaConfig>`
- `saveSystemPersona(config: { name?: string; instructions: string }, db?: AppDatabase): Promise<SystemPersonaConfig>`
- `resetSystemPersona(db?: AppDatabase): Promise<SystemPersonaConfig>`

Validation Rules:
- `name`: String, max 100 characters, optional.
- `instructions`: String, max 10,000 characters, required.
- Sanitization: Trims whitespace and strips non-printable control characters.

---

## 3. Prompt Synthesis & Caching Integration

### 3.1 Layer 1 Structure (`src/lib/ai/prompt.ts`)
Modern LLM caching relies on exact byte-matching from the start of the prompt. Dynamic elements (search results, skills, cognitive memories) follow static elements.

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Base Behavioral Prompt (Static Prefix)             │
│                                                             │
│ 1. [Custom System Persona Instructions]                     │
│    (or Default: "You are Yggdrasil...")                     │
│                                                             │
│ 2. \n\n# Core Invariants & Tool Usage Principles:           │
│    - Autonomous Web Research ('web_search')                 │
│    - Deliverables & Artifact Creation ('artifact_publish')  │
│    - Task Management ('task_list_manager')                  │
│    - Interactive Questionnaires ('ask_user_question')       │
├─────────────────────────────────────────────────────────────┤
│ Layer 1b: Installed Skills Catalog (Dynamic)                │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: Learned Procedural Mistake-Prevention Rules        │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: Semantic User Profile & Preferences                │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: Cognitive Memory Context (Working + Episodic)      │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Dynamic Prompt Synthesis Changes
`synthesizeSystemPrompt` retrieves the active persona via `getSystemPersona()` and formats Layer 1:
```typescript
const persona = await getSystemPersona(db);
const personaText = persona.instructions.trim() || DEFAULT_SYSTEM_PERSONA.instructions;
const baseRawPrompt = `${personaText}\n\n# Core Invariants & Tool Usage Principles:\n\n${CORE_TOOL_INVARIANTS}`;
```

---

## 4. API Endpoints

### 4.1 Routes (`src/app/api/settings/persona/route.ts`)
- **`GET /api/settings/persona`**:
  - Response:
    ```json
    {
      "persona": {
        "name": "Software Architect",
        "instructions": "You are a senior staff engineer...",
        "updatedAt": 1757116800000
      },
      "defaultPersona": {
        "name": "Yggdrasil",
        "instructions": "You are Yggdrasil...",
        "updatedAt": 0
      }
    }
    ```
- **`PUT /api/settings/persona`**:
  - Body: `{ "name": "...", "instructions": "..." }`
  - Validates via Zod schema.
  - Updates SQLite `settings` table.
  - Response: `{ "success": true, "persona": { ... } }`
- **`POST /api/settings/persona/reset`**:
  - Resets the `system_persona` key back to default.
  - Response: `{ "success": true, "persona": { ... } }`

---

## 5. UI / UX Design in Settings

### 5.1 Persona Settings Tab (`src/components/settings/persona-tab.tsx`)
- Added as a tab in `src/components/settings/tabs.tsx` alongside General, Providers, Tools, and Memory.
- Icon: `UserCircle` from `@phosphor-icons/react`.
- Components:
  - **Persona Name**: Text input for label / title.
  - **System Instructions**: Multiline `Textarea` for instructions with monospaced font option.
  - **Token Counter**: Real-time token estimation badge beneath the textarea (e.g. `~54 tokens`).
  - **Controls**:
    - **Save Changes** (Button, Primary): Persists changes with feedback spinner / toast.
    - **Reset to Default** (Button, Outline / Ghost): Reverts input fields to default persona.
    - **Status Badge**: Indicates whether custom persona is currently active or using system defaults.

---

## 6. Testing & Quality Assurance

### 6.1 Unit & Integration Tests
- `src/lib/__tests__/persona-service.test.ts`:
  - CRUD operations on `settings` table.
  - Fallback to `DEFAULT_SYSTEM_PERSONA` when unset or empty.
  - Zod validation and length bounds.
- `src/lib/ai/__tests__/prompt-persona.test.ts`:
  - Verify synthesized prompt begins with custom persona text.
  - Verify core tool invariants follow immediately after.
  - Verify token budgets remain respected.
- `src/app/api/settings/persona/__tests__/route.test.ts`:
  - HTTP `GET`, `PUT`, and `POST /reset` endpoint contract testing.
- `src/components/__tests__/persona-settings-tab.test.tsx`:
  - UI rendering, live token counting, submit handling, and reset interaction.

---

## 7. Security & Invariants (Global Rules Compliance)
- **Isolation Invariant (Rule 06)**: All data remains strictly within project SQLite database.
- **Fail Fast & Input Validation (Rule 01 & 04)**: Zod validation at API boundaries; invalid inputs rejected with 400 status.
- **No Memory Leaks (Rule 02)**: No unbounded memory caches; state managed via standard React hooks and ephemeral requests.
- **Vitest Concurrency (Rule 18)**: Single sequential test execution with worker memory boundaries.
