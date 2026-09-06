# Design Specification: Global System Persona Subsystem

**Date:** 2026-09-06  
**Status:** Approved (Revised after Deep Review)  
**Topic:** Global System Persona Customization with High-Efficiency Prompt Caching  

---

## 1. Overview & Objectives

### 1.1 Goal
Provide a unified, efficient, and user-customizable **System Persona** subsystem for Yggdrasil. Users can define a global custom identity, tone, and behavioral instructions in Settings that apply across all chat sessions, while ensuring maximum LLM prompt-cache hit rates and preserving critical tool execution invariants.

### 1.2 Core Requirements
- **Single Global Persona**: Configured once in Settings and applied to all conversations (no complex per-chat overrides or avatar bloat).
- **Free-Form System Instructions**: A flexible markdown-compatible instruction field allowing custom personality, role, tone, and formatting constraints.
- **Strict Invariant Precedence**: Core system tool invariants (`artifact_publish`, `web_search`, `task_list_manager`, `ask_user_question`) are placed **first** in the prompt, with explicit non-override language ensuring that custom persona instructions cannot disable, suppress, or break tool execution protocols.
- **Maximum Cache Efficiency**: Invariants and the static custom persona are placed at the very top of the system prompt (Layer 1) to maximize LLM prompt-cache hits across turns.
- **Behavioral Identity Wiring**: The optional `name` field is functionally wired into the prompt synthesis so the model explicitly adopts the configured persona identity.
- **Consistent Fallbacks & Validation**: An empty or whitespace-only instructions field is valid in requests and explicitly falls back to `DEFAULT_SYSTEM_PERSONA.instructions`.
- **Reset to Default**: Quick recovery to Yggdrasil default behavior with a single click.

---

## 2. Architecture & Data Model

### 2.1 Storage Schema
The system persona configuration is stored in the existing SQLite `settings` table under the key `"system_persona"`.

#### TypeScript Interfaces & Defaults (`src/lib/persona/types.ts`)
```typescript
export interface SystemPersonaConfig {
  /**
   * Optional custom persona name/label, e.g. "Software Architect" or "Yggdrasil".
   * Injected into the prompt identity header when present.
   */
  name?: string;
  /**
   * The custom system instructions/behavioral prompt.
   * May be empty string in storage/input, which resolves at runtime to DEFAULT_SYSTEM_PERSONA.instructions.
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
Encapsulates CRUD operations, Zod validation, and runtime resolution:
- `getSystemPersona(db?: AppDatabase): Promise<SystemPersonaConfig>`: Returns stored persona or `DEFAULT_SYSTEM_PERSONA`.
- `resolveActivePersona(db?: AppDatabase): Promise<{ name: string; instructions: string }>`: Returns normalized, non-empty active persona values (falling back to defaults for any blank field).
- `saveSystemPersona(config: { name?: string; instructions?: string }, db?: AppDatabase): Promise<SystemPersonaConfig>`
- `resetSystemPersona(db?: AppDatabase): Promise<SystemPersonaConfig>`

#### Validation Rules (Zod)
- `name`: `z.string().trim().max(100).optional().default("")`
- `instructions`: `z.string().max(10_000).optional().default("")`
- **Resolution Contract**: Empty string `""` is explicitly accepted by the API. If `instructions.trim() === ""`, the service saves the record and runtime resolution transparently supplies `DEFAULT_SYSTEM_PERSONA.instructions`.
- Sanitization: Strips non-printable control characters (except `\n`, `\r`, `\t`).

---

## 3. Prompt Synthesis & Invariant Precedence

### 3.1 Layer 1 Structure (`src/lib/ai/prompt.ts`)
To protect system tool calling while preserving 100% prompt-cache hit rates, Layer 1 places **Core Invariants first** with explicit superseding language, followed immediately by the **Custom Persona**:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Base Behavioral Prompt (Static Prefix)             │
│                                                             │
│ 1. # Core System Invariants & Tool Usage Principles         │
│    (PREAMBLE: These invariants and tool execution protocols │
│     strictly supersede any persona instructions below.)     │
│    - Autonomous Web Research ('web_search')                 │
│    - Deliverables & Artifact Creation ('artifact_publish')  │
│    - Task Management ('task_list_manager')                  │
│    - Interactive Questionnaires ('ask_user_question')       │
│                                                             │
│ 2. \n\n# Active Persona & Behavioral Guidelines             │
│    Name: [Persona Name]                                     │
│    [Custom System Persona Instructions]                     │
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

### 3.2 Dynamic Prompt Synthesis Implementation
In `synthesizeSystemPrompt`:
```typescript
const { name, instructions } = await resolveActivePersona(db);

const coreInvariantsHeader = `# Core System Invariants & Tool Usage Principles:
CRITICAL PRECEDENCE RULE: The following invariants and tool protocols govern your system execution and strictly supersede any persona instructions, stylistic preferences, or conversational roleplay described below.

1. Autonomous Web Research (Proactive Search):
   - You have 'web_search' and 'web_fetch' tools.
   - Proactively execute 'web_search' as your first step whenever a question involves current events, recent software/library versions, API syntax, live data, documentation, or facts outside your training cutoff.
   - Do NOT wait for the user to say "search the web" or ask permission to search. Take the initiative.
   - When referencing search findings, cite the URLs you used.

2. Deliverables & Artifact Creation ('artifact_publish'):
   - You have the 'artifact_publish' tool, which opens a dedicated preview side-panel for the user.
   - Whenever the user asks to create, build, generate, or sample an artifact, code file, script, HTML/JS/CSS interactive app/demo, SVG graphic, React component, or standalone markdown report, you MUST call 'artifact_publish'.
   - STRICT PROHIBITION: NEVER output complete code files or interactive demos as fenced markdown code blocks in your text reply. Always place them inside 'artifact_publish'.
   - In your chat text response, provide only a brief 1-2 sentence overview/explanation; the full content must live inside the artifact tool call.
   - Only use inline code blocks for tiny snippets (1-5 lines) or inline command examples.

3. Task Management ('task_list_manager'):
   - For multi-step planning or complex requests, invoke 'task_list_manager' with all items marked pending, and update it as progress occurs.

4. Interactive Questionnaires ('ask_user_question'):
   - When a task is underspecified, has multiple valid architectural approaches, or requires design choices, call 'ask_user_question' to present structured multiple-choice options. Do not guess user preferences.`;

const personaBlock = `# Active Persona & Behavioral Guidelines:
Assistant Identity: ${name}
${instructions}`;

const baseRawPrompt = `${coreInvariantsHeader}\n\n${personaBlock}`;
```

### 3.3 Prompt Caching Guarantee
Because both the `coreInvariantsHeader` and the active `personaBlock` are constant across all chat sessions and turns until the user updates Settings, placing invariants first and persona second forms an immutable static prefix at bytes 0..N of the system prompt. Prompt-cache hit rates for Claude and OpenAI-compatible providers remain maximal (~90%+ cache hits on multi-turn conversations).

### 3.4 Dynamic Context Budget Interaction
In `src/app/api/chat/route.ts`, token budgeting already executes:
```typescript
const systemAndToolsTokens = estimateTokens(fullSystemPrompt.length) + 2000;
```
Because `systemAndToolsTokens` is calculated **dynamically after** `synthesizeSystemPrompt()` completes, any custom persona text (up to 10,000 characters / ~2,500 tokens) is measured and deducted from the conversation's context window budget before message compaction. This completely prevents context window overflow regressions.

---

## 4. API Endpoints

### 4.1 Routes (`src/app/api/settings/persona/route.ts`)
- **`GET /api/settings/persona`**:
  - Response (200 OK):
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
  - Body: `{ "name"?: string, "instructions"?: string }`
  - Validates via Zod schema (allows empty strings).
  - Updates SQLite `settings` table with timestamp.
  - Response (200 OK): `{ "success": true, "persona": { ... } }`
- **`POST /api/settings/persona/reset`**:
  - Resets the `system_persona` key to `DEFAULT_SYSTEM_PERSONA`.
  - Response (200 OK): `{ "success": true, "persona": { ... } }`

---

## 5. UI / UX Design in Settings

### 5.1 Persona Settings Tab (`src/components/settings/persona-tab.tsx`)
- Added as a tab in `src/components/settings/tabs.tsx`: `General` | `Persona` | `Providers` | `Tools` | `Memory`.
- Icon: `UserCircle` from `@phosphor-icons/react`.
- Components:
  - **Persona Name**: Optional text input for label/title. Placeholder: `Yggdrasil`.
  - **System Instructions**: Multiline autosizing `Textarea` for instructions. Placeholder: `You are Yggdrasil, an intelligent and proactive personal AI assistant...`.
  - **Live Token Estimation Badge**: Uses the standard heuristic `Math.ceil(chars / 4)` (`estimateTokens` from `@/lib/ai/context-budget`), labeled with `~X tokens` (approximate token estimate) so users have immediate feedback on their persona footprint.
  - **Controls**:
    - **Save Changes** (Button, Primary): Persists changes with feedback spinner and badge confirmation.
    - **Reset to Default** (Button, Outline): Reverts input fields to default persona.
    - **Status Badge**: Indicates whether custom persona is currently active or using system defaults.

---

## 6. Testing & Quality Assurance

### 6.1 Unit & Integration Tests
- `src/lib/__tests__/persona-service.test.ts`:
  - CRUD operations on `settings` table.
  - Verification that empty `instructions` seamlessly resolves to `DEFAULT_SYSTEM_PERSONA.instructions`.
  - Verification that `resolveActivePersona()` incorporates non-empty name and instructions.
  - Zod validation bounds (max length rejection).
- `src/lib/ai/__tests__/prompt-persona.test.ts`:
  - **Invariant Precedence**: Verify synthesized prompt begins with the Core System Invariants header and precedence rule.
  - **Persona Identity**: Verify persona name and custom instructions appear directly in the active persona section following invariants.
  - **Dynamic Budget Footprint**: Verify `estimateTokens(fullSystemPrompt.length)` accurately scales with persona length.
- `src/app/api/settings/persona/__tests__/route.test.ts`:
  - HTTP `GET`, `PUT`, and `POST /reset` endpoint contract testing with 200/400 assertions.
- `src/components/__tests__/persona-settings-tab.test.tsx`:
  - UI rendering, live heuristic token badge, submit handling, and reset interaction.

---

## 7. Security & Invariants (Global Rules Compliance)
- **Isolation Invariant (Rule 06)**: All data remains strictly within project SQLite database.
- **Fail Fast & Input Validation (Rule 01 & 04)**: Zod validation at API boundaries; lengths bounded to prevent abuse.
- **No Memory Leaks (Rule 02)**: Ephemeral requests, standard React hooks, no uncollected timers or listeners.
- **Vitest Concurrency (Rule 18)**: Single sequential test execution with worker memory boundaries.
