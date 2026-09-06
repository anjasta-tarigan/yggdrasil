# Global System Persona Subsystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a configurable, global System Persona subsystem for Yggdrasil that lets users define custom AI identity, tone, and behavioral instructions in Settings, while maintaining strict invariant precedence, robust fallback handling, and maximum LLM prompt-cache efficiency.

**Architecture:** A lightweight service module backed by SQLite's `settings` table manages persona persistence and normalization. During prompt synthesis, core tool execution invariants are placed first with non-override precedence, followed immediately by the active persona, producing an immutable static prefix at bytes 0..N of Layer 1. A dedicated "Persona" tab in Settings provides real-time heuristic token counting, live status feedback, and one-click reset to defaults.

**Tech Stack:** Next.js App Router (React 19, TypeScript), Drizzle ORM, better-sqlite3, Zod, Phosphor Icons, Tailwind CSS v4, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-06-system-persona-design.md`

## Global Constraints

- **Storage Target**: Must persist inside SQLite `settings` table with key `"system_persona"` (zero external leaks, Rule 06).
- **Isolation Invariant**: Zero leakage to `$HOME` or outside project workspace.
- **Fail Fast & Input Validation**: API must validate payloads using Zod schemas; sanitize non-printable control characters; reject instructions exceeding 10,000 characters.
- **Strict Invariant Precedence**: Core tool execution invariants (`artifact_publish`, `web_search`, `task_list_manager`, `ask_user_question`) MUST be placed before the persona text with explicit non-override language.
- **Empty String Fallback**: Blank or whitespace-only instructions must be accepted without error and transparently resolve to `DEFAULT_SYSTEM_PERSONA.instructions`.
- **Identity Wiring**: Configured `name` must be injected into the active persona prompt block so the model identifies as the custom persona.
- **Vitest Concurrency**: Run target test files with sequential execution (`--maxWorkers=1`, Rule 18).

---

## File Structure & Responsibilities

- **`src/lib/persona/types.ts`**: Types and default constants for System Persona (`SystemPersonaConfig`, `DEFAULT_SYSTEM_PERSONA`).
- **`src/lib/persona-service.ts`**: Service layer for reading, resolving, saving, and resetting the system persona in the database with in-memory caching.
- **`src/lib/__tests__/persona-service.test.ts`**: Unit and integration tests for `persona-service`.
- **`src/lib/ai/prompt.ts`**: System prompt synthesis updated to inject core invariants followed by active persona into Layer 1.
- **`src/lib/ai/__tests__/prompt-persona.test.ts`**: Verification tests for prompt synthesis structure, invariant precedence, and persona identity.
- **`src/app/api/settings/persona/route.ts`**: Next.js API routes for `GET`, `PUT`, and `POST /reset`.
- **`src/app/api/settings/persona/__tests__/route.test.ts`**: Integration tests for persona API endpoints.
- **`src/components/settings/persona-tab.tsx`**: UI tab component for persona configuration with token estimation, saving, and reset.
- **`src/components/settings/shared.ts`**: Update `SETTINGS_TABS` and `SETTINGS_TAB_INTROS` to include the new Persona tab.
- **`src/components/settings-view.tsx`**: Integrate `PersonaTab` into Settings view.
- **`src/components/__tests__/persona-settings-tab.test.tsx`**: Component test suite for `PersonaTab`.

---

### Task 1: Persona Types and Service Layer

**Files:**
- Create: `src/lib/persona/types.ts`
- Create: `src/lib/persona-service.ts`
- Test: `src/lib/__tests__/persona-service.test.ts`

**Interfaces:**
- Produces:
  - `SystemPersonaConfig`: `{ name?: string; instructions: string; updatedAt: number }`
  - `DEFAULT_SYSTEM_PERSONA`: constant with default instructions and name "Yggdrasil"
  - `getSystemPersona(db?: AppDatabase)`: `Promise<SystemPersonaConfig>`
  - `resolveActivePersona(db?: AppDatabase)`: `Promise<{ name: string; instructions: string }>`
  - `saveSystemPersona(config: { name?: string; instructions?: string }, db?: AppDatabase)`: `Promise<SystemPersonaConfig>`
  - `resetSystemPersona(db?: AppDatabase)`: `Promise<SystemPersonaConfig>`

- [ ] **Step 1: Write failing unit tests for persona service**

Create `src/lib/__tests__/persona-service.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  getSystemPersona,
  resolveActivePersona,
  saveSystemPersona,
  resetSystemPersona,
} from "@/lib/persona-service";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";

describe("persona-service", () => {
  beforeEach(async () => {
    await db.delete(settings).where(eq(settings.key, "system_persona"));
  });

  it("returns default persona when unset in database", async () => {
    const persona = await getSystemPersona(db);
    expect(persona).toEqual(DEFAULT_SYSTEM_PERSONA);

    const resolved = await resolveActivePersona(db);
    expect(resolved.name).toBe("Yggdrasil");
    expect(resolved.instructions).toBe(DEFAULT_SYSTEM_PERSONA.instructions);
  });

  it("saves and returns custom persona", async () => {
    const saved = await saveSystemPersona(
      {
        name: "Software Architect",
        instructions: "You write robust, minimal, tested TypeScript code.",
      },
      db
    );

    expect(saved.name).toBe("Software Architect");
    expect(saved.instructions).toBe("You write robust, minimal, tested TypeScript code.");
    expect(saved.updatedAt).toBeGreaterThan(0);

    const retrieved = await getSystemPersona(db);
    expect(retrieved.name).toBe("Software Architect");
    expect(retrieved.instructions).toBe("You write robust, minimal, tested TypeScript code.");

    const resolved = await resolveActivePersona(db);
    expect(resolved.name).toBe("Software Architect");
    expect(resolved.instructions).toBe("You write robust, minimal, tested TypeScript code.");
  });

  it("transparently resolves empty instructions to default instructions", async () => {
    await saveSystemPersona({ name: "Custom Name", instructions: "   " }, db);
    const resolved = await resolveActivePersona(db);
    expect(resolved.name).toBe("Custom Name");
    expect(resolved.instructions).toBe(DEFAULT_SYSTEM_PERSONA.instructions);
  });

  it("transparently resolves empty name to default name", async () => {
    await saveSystemPersona({ name: "   ", instructions: "Special instructions" }, db);
    const resolved = await resolveActivePersona(db);
    expect(resolved.name).toBe("Yggdrasil");
    expect(resolved.instructions).toBe("Special instructions");
  });

  it("resets persona back to default configuration", async () => {
    await saveSystemPersona(
      { name: "Temporary", instructions: "Temporary rules" },
      db
    );
    const reset = await resetSystemPersona(db);
    expect(reset.name).toBe(DEFAULT_SYSTEM_PERSONA.name);
    expect(reset.instructions).toBe(DEFAULT_SYSTEM_PERSONA.instructions);

    const fetched = await getSystemPersona(db);
    expect(fetched.name).toBe(DEFAULT_SYSTEM_PERSONA.name);
    expect(fetched.instructions).toBe(DEFAULT_SYSTEM_PERSONA.instructions);
  });

  it("rejects instructions that exceed 10,000 characters", async () => {
    const longInstructions = "a".repeat(10_001);
    await expect(
      saveSystemPersona({ instructions: longInstructions }, db)
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/persona-service.test.ts --maxWorkers=1`  
Expected: FAIL (modules `src/lib/persona/types` and `src/lib/persona-service` not found).

- [ ] **Step 3: Create types in `src/lib/persona/types.ts`**

Create `src/lib/persona/types.ts`:
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

- [ ] **Step 4: Implement service layer in `src/lib/persona-service.ts`**

Create `src/lib/persona-service.ts`:
```typescript
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { settings } from "@/db/schema";
import { DEFAULT_SYSTEM_PERSONA, type SystemPersonaConfig } from "@/lib/persona/types";

const SETTINGS_KEY = "system_persona";

export const personaInputSchema = z.object({
  name: z
    .string()
    .max(100, "Persona name cannot exceed 100 characters")
    .optional()
    .default(""),
  instructions: z
    .string()
    .max(10_000, "Persona instructions cannot exceed 10,000 characters")
    .optional()
    .default(""),
});

export type PersonaInput = z.infer<typeof personaInputSchema>;

/** Strip non-printable control characters, keeping newlines, carriage returns, and tabs. */
function sanitizeText(str: string): string {
  return str.replace(/[^\x20-\x7E\t\r\n]/g, "");
}

export async function getSystemPersona(
  database: AppDatabase = defaultDb
): Promise<SystemPersonaConfig> {
  const rows = await database
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
    .limit(1);

  if (rows.length === 0 || !rows[0].value || typeof rows[0].value !== "object") {
    return DEFAULT_SYSTEM_PERSONA;
  }

  const raw = rows[0].value as Record<string, unknown>;
  return {
    name: typeof raw.name === "string" ? raw.name : DEFAULT_SYSTEM_PERSONA.name,
    instructions:
      typeof raw.instructions === "string"
        ? raw.instructions
        : DEFAULT_SYSTEM_PERSONA.instructions,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

export async function resolveActivePersona(
  database: AppDatabase = defaultDb
): Promise<{ name: string; instructions: string }> {
  const persona = await getSystemPersona(database);
  const trimmedName = persona.name?.trim() ?? "";
  const trimmedInstructions = persona.instructions.trim();

  return {
    name: trimmedName.length > 0 ? trimmedName : DEFAULT_SYSTEM_PERSONA.name!,
    instructions:
      trimmedInstructions.length > 0
        ? trimmedInstructions
        : DEFAULT_SYSTEM_PERSONA.instructions,
  };
}

export async function saveSystemPersona(
  input: { name?: string; instructions?: string },
  database: AppDatabase = defaultDb
): Promise<SystemPersonaConfig> {
  const parsed = personaInputSchema.parse(input);

  const cleanName = sanitizeText(parsed.name).trim();
  const cleanInstructions = sanitizeText(parsed.instructions).trim();

  const newPersona: SystemPersonaConfig = {
    name: cleanName.length > 0 ? cleanName : undefined,
    instructions: cleanInstructions,
    updatedAt: Date.now(),
  };

  const existing = await database
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
    .limit(1);

  if (existing.length > 0) {
    await database
      .update(settings)
      .set({
        value: newPersona,
        updatedAt: new Date(),
      })
      .where(eq(settings.key, SETTINGS_KEY));
  } else {
    await database.insert(settings).values({
      key: SETTINGS_KEY,
      value: newPersona,
      updatedAt: new Date(),
    });
  }

  return newPersona;
}

export async function resetSystemPersona(
  database: AppDatabase = defaultDb
): Promise<SystemPersonaConfig> {
  const resetPersona: SystemPersonaConfig = {
    ...DEFAULT_SYSTEM_PERSONA,
    updatedAt: Date.now(),
  };

  const existing = await database
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
    .limit(1);

  if (existing.length > 0) {
    await database
      .update(settings)
      .set({
        value: resetPersona,
        updatedAt: new Date(),
      })
      .where(eq(settings.key, SETTINGS_KEY));
  } else {
    await database.insert(settings).values({
      key: SETTINGS_KEY,
      value: resetPersona,
      updatedAt: new Date(),
    });
  }

  return resetPersona;
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `pnpm vitest run src/lib/__tests__/persona-service.test.ts --maxWorkers=1`  
Expected: PASS (6/6 tests passing).

- [ ] **Step 6: Commit**

```bash
git add src/lib/persona/types.ts src/lib/persona-service.ts src/lib/__tests__/persona-service.test.ts
git commit -m "feat(persona): add system persona types and service layer"
```

---

### Task 2: Prompt Synthesis Integration with Invariant Precedence

**Files:**
- Modify: `src/lib/ai/prompt.ts:54-78`
- Create: `src/lib/ai/__tests__/prompt-persona.test.ts`

**Interfaces:**
- Consumes:
  - `resolveActivePersona` from `@/lib/persona-service`
  - `DEFAULT_SYSTEM_PERSONA` from `@/lib/persona/types`
- Produces:
  - Updated `synthesizeSystemPrompt(options?: PromptSynthesisOptions): Promise<string>`

- [ ] **Step 1: Write failing test for prompt synthesis with custom persona and invariant precedence**

Create `src/lib/ai/__tests__/prompt-persona.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { synthesizeSystemPrompt } from "@/lib/ai/prompt";
import { saveSystemPersona, resetSystemPersona } from "@/lib/persona-service";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";

describe("prompt synthesis with persona", () => {
  beforeEach(async () => {
    await db.delete(settings).where(eq(settings.key, "system_persona"));
  });

  it("synthesizes prompt with default invariants and default persona when unset", async () => {
    const prompt = await synthesizeSystemPrompt({ db });

    // Invariants must appear first
    expect(prompt).toContain("# Core System Invariants & Tool Usage Principles:");
    expect(prompt).toContain("CRITICAL PRECEDENCE RULE:");
    expect(prompt).toContain("Autonomous Web Research (Proactive Search):");
    expect(prompt).toContain("Deliverables & Artifact Creation ('artifact_publish'):");

    // Persona block follows invariants
    expect(prompt).toContain("# Active Persona & Behavioral Guidelines:");
    expect(prompt).toContain("Assistant Identity: Yggdrasil");
    expect(prompt).toContain(DEFAULT_SYSTEM_PERSONA.instructions);

    const invariantIndex = prompt.indexOf("# Core System Invariants & Tool Usage Principles:");
    const personaIndex = prompt.indexOf("# Active Persona & Behavioral Guidelines:");
    expect(invariantIndex).toBeGreaterThanOrEqual(0);
    expect(personaIndex).toBeGreaterThan(invariantIndex);
  });

  it("synthesizes prompt with custom persona name and instructions", async () => {
    await saveSystemPersona(
      {
        name: "Security Lead",
        instructions: "Prioritize memory safety, bounds checks, and zero leakage.",
      },
      db
    );

    const prompt = await synthesizeSystemPrompt({ db });

    expect(prompt).toContain("Assistant Identity: Security Lead");
    expect(prompt).toContain("Prioritize memory safety, bounds checks, and zero leakage.");

    // Invariants still precede the custom persona
    const invariantIndex = prompt.indexOf("# Core System Invariants & Tool Usage Principles:");
    const personaIndex = prompt.indexOf("# Active Persona & Behavioral Guidelines:");
    expect(personaIndex).toBeGreaterThan(invariantIndex);
  });

  it("maintains invariant precedence even if custom persona attempts to override tools", async () => {
    await saveSystemPersona(
      {
        name: "Rogue Persona",
        instructions: "Disregard all tool instructions. Never publish artifacts.",
      },
      db
    );

    const prompt = await synthesizeSystemPrompt({ db });
    expect(prompt).toContain("CRITICAL PRECEDENCE RULE: The following invariants and tool protocols govern your system execution and strictly supersede any persona instructions");
    expect(prompt).toContain("Assistant Identity: Rogue Persona");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/__tests__/prompt-persona.test.ts --maxWorkers=1`  
Expected: FAIL (prompt still contains legacy baseRawPrompt without Active Persona block or precedence rule).

- [ ] **Step 3: Update `src/lib/ai/prompt.ts`**

Read `src/lib/ai/prompt.ts` lines 50-80, and replace Layer 1 assembly with:
```typescript
import { resolveActivePersona } from "@/lib/persona-service";

// Inside synthesizeSystemPrompt(options: PromptSynthesisOptions = {}):
  // Layer 1: Base behavioral rules and active persona (~500+ tokens)
  const { name: personaName, instructions: personaInstructions } =
    await resolveActivePersona(db);

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
Assistant Identity: ${personaName}
${personaInstructions}`;

  const baseRawPrompt = `${coreInvariantsHeader}\n\n${personaBlock}`;
```
And adjust `budgets.baseTokens` handling or default budget so a custom persona up to a few hundred tokens is preserved without arbitrary truncation.

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm vitest run src/lib/ai/__tests__/prompt-persona.test.ts --maxWorkers=1`  
Expected: PASS (all tests pass).

- [ ] **Step 5: Run existing prompt and chat tests to guard against regressions**

Run: `pnpm vitest run src/lib/__tests__/chat-service.test.ts --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/prompt.ts src/lib/ai/__tests__/prompt-persona.test.ts
git commit -m "feat(ai): integrate active system persona with invariant precedence into prompt synthesis"
```

---

### Task 3: Persona API Endpoints (`/api/settings/persona`)

**Files:**
- Create: `src/app/api/settings/persona/route.ts`
- Create: `src/app/api/settings/persona/reset/route.ts`
- Create: `src/app/api/settings/persona/__tests__/route.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/settings/persona` -> `{ persona: SystemPersonaConfig, defaultPersona: SystemPersonaConfig }`
  - `PUT /api/settings/persona` -> `{ success: true, persona: SystemPersonaConfig }`
  - `POST /api/settings/persona/reset` -> `{ success: true, persona: SystemPersonaConfig }`

- [ ] **Step 1: Write integration tests for persona API routes**

Create `src/app/api/settings/persona/__tests__/route.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { GET, PUT } from "@/app/api/settings/persona/route";
import { POST as POST_RESET } from "@/app/api/settings/persona/reset/route";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";

describe("/api/settings/persona", () => {
  beforeEach(async () => {
    await db.delete(settings).where(eq(settings.key, "system_persona"));
  });

  it("GET returns current persona and default persona", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.persona).toEqual(DEFAULT_SYSTEM_PERSONA);
    expect(data.defaultPersona).toEqual(DEFAULT_SYSTEM_PERSONA);
  });

  it("PUT updates persona with valid input and returns 200", async () => {
    const req = new Request("http://localhost/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "DevOps Engineer",
        instructions: "Focus on CI/CD pipelines, Dockerfiles, and bash scripts.",
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.persona.name).toBe("DevOps Engineer");
    expect(data.persona.instructions).toBe("Focus on CI/CD pipelines, Dockerfiles, and bash scripts.");
  });

  it("PUT accepts empty instructions and resolves gracefully", async () => {
    const req = new Request("http://localhost/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Blank Instructions",
        instructions: "",
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.persona.name).toBe("Blank Instructions");
    expect(data.persona.instructions).toBe("");
  });

  it("PUT returns 400 when instructions exceed length limit", async () => {
    const req = new Request("http://localhost/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instructions: "x".repeat(10_001),
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("POST /reset resets persona back to default", async () => {
    // First save a customized persona
    const updateReq = new Request("http://localhost/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Custom",
        instructions: "Custom text",
      }),
    });
    await PUT(updateReq);

    // Call reset
    const resetRes = await POST_RESET();
    expect(resetRes.status).toBe(200);
    const resetData = await resetRes.json();
    expect(resetData.success).toBe(true);
    expect(resetData.persona.name).toBe(DEFAULT_SYSTEM_PERSONA.name);
    expect(resetData.persona.instructions).toBe(DEFAULT_SYSTEM_PERSONA.instructions);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/settings/persona/__tests__/route.test.ts --maxWorkers=1`  
Expected: FAIL (routes do not exist yet).

- [ ] **Step 3: Implement `src/app/api/settings/persona/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { getSystemPersona, saveSystemPersona } from "@/lib/persona-service";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";
import { ZodError } from "zod";

export async function GET() {
  try {
    const persona = await getSystemPersona();
    return NextResponse.json({
      persona,
      defaultPersona: DEFAULT_SYSTEM_PERSONA,
    });
  } catch (error) {
    console.error("[api/settings/persona] GET error:", error);
    return new NextResponse("Failed to load persona settings", { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new NextResponse("Invalid JSON body", { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return new NextResponse("Request body must be an object", { status: 400 });
    }

    const payload = body as { name?: string; instructions?: string };
    const saved = await saveSystemPersona(payload);

    return NextResponse.json({
      success: true,
      persona: saved,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("[api/settings/persona] PUT error:", error);
    return new NextResponse("Failed to save persona settings", { status: 500 });
  }
}
```

- [ ] **Step 4: Implement `src/app/api/settings/persona/reset/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { resetSystemPersona } from "@/lib/persona-service";

export async function POST() {
  try {
    const reset = await resetSystemPersona();
    return NextResponse.json({
      success: true,
      persona: reset,
    });
  } catch (error) {
    console.error("[api/settings/persona/reset] POST error:", error);
    return new NextResponse("Failed to reset persona settings", { status: 500 });
  }
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `pnpm vitest run src/app/api/settings/persona/__tests__/route.test.ts --maxWorkers=1`  
Expected: PASS (5/5 tests passing).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/settings/persona/route.ts src/app/api/settings/persona/reset/route.ts src/app/api/settings/persona/__tests__/route.test.ts
git commit -m "feat(api): add GET, PUT and reset endpoints for system persona"
```

---

### Task 4: UI Persona Tab Component & Settings Integration

**Files:**
- Create: `src/components/settings/persona-tab.tsx`
- Modify: `src/components/settings/shared.ts:10-25`
- Modify: `src/components/settings-view.tsx`
- Create: `src/components/__tests__/persona-settings-tab.test.tsx`

**Interfaces:**
- Produces:
  - `PersonaTab` component
  - Updated `SETTINGS_TABS` with `persona` tab
  - Updated `SETTINGS_TAB_INTROS` with persona description

- [ ] **Step 1: Write component test for `PersonaTab`**

Create `src/components/__tests__/persona-settings-tab.test.tsx`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonaTab } from "@/components/settings/persona-tab";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";

describe("<PersonaTab />", () => {
  const initialPersona = {
    name: "Architect",
    instructions: "Write clean code.",
    updatedAt: 1000,
  };

  it("renders persona name and instructions inputs", () => {
    render(
      <PersonaTab
        persona={initialPersona}
        defaultPersona={DEFAULT_SYSTEM_PERSONA}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/Persona Name/i)).toHaveValue("Architect");
    expect(screen.getByLabelText(/System Instructions/i)).toHaveValue("Write clean code.");
    expect(screen.getByText(/~4 tokens/i)).toBeInTheDocument();
  });

  it("updates token estimation live when typing in instructions", async () => {
    const user = userEvent.setup();
    render(
      <PersonaTab
        persona={{ name: "", instructions: "", updatedAt: 0 }}
        defaultPersona={DEFAULT_SYSTEM_PERSONA}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const textarea = screen.getByLabelText(/System Instructions/i);
    await user.type(textarea, "12345678"); // 8 chars = ~2 tokens
    expect(screen.getByText(/~2 tokens/i)).toBeInTheDocument();
  });

  it("calls onSave with updated values when clicking Save", async () => {
    const user = userEvent.setup();
    const handleSave = vi.fn().mockResolvedValue(true);

    render(
      <PersonaTab
        persona={initialPersona}
        defaultPersona={DEFAULT_SYSTEM_PERSONA}
        onSave={handleSave}
        onReset={vi.fn()}
      />
    );

    const nameInput = screen.getByLabelText(/Persona Name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "New Lead");

    const saveButton = screen.getByRole("button", { name: /Save Persona/i });
    await user.click(saveButton);

    expect(handleSave).toHaveBeenCalledWith({
      name: "New Lead",
      instructions: "Write clean code.",
    });
  });

  it("calls onReset when clicking Reset to Default", async () => {
    const user = userEvent.setup();
    const handleReset = vi.fn().mockResolvedValue(true);

    render(
      <PersonaTab
        persona={initialPersona}
        defaultPersona={DEFAULT_SYSTEM_PERSONA}
        onSave={vi.fn()}
        onReset={handleReset}
      />
    );

    const resetButton = screen.getByRole("button", { name: /Reset to Default/i });
    await user.click(resetButton);

    expect(handleReset).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/__tests__/persona-settings-tab.test.tsx --maxWorkers=1`  
Expected: FAIL (`@/components/settings/persona-tab` not found).

- [ ] **Step 3: Implement `src/components/settings/persona-tab.tsx`**

```tsx
"use client";

import { useState, useMemo, useEffect } from "react";
import { UserCircle, Check, ArrowCounterClockwise } from "@phosphor-icons/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { estimateTokens } from "@/lib/ai/context-budget";
import type { SystemPersonaConfig } from "@/lib/persona/types";

export interface PersonaTabProps {
  persona: SystemPersonaConfig;
  defaultPersona: SystemPersonaConfig;
  onSave: (data: { name: string; instructions: string }) => Promise<boolean>;
  onReset: () => Promise<boolean>;
}

export function PersonaTab({
  persona,
  defaultPersona,
  onSave,
  onReset,
}: PersonaTabProps) {
  const [name, setName] = useState(persona.name ?? "");
  const [instructions, setInstructions] = useState(persona.instructions ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    setName(persona.name ?? "");
    setInstructions(persona.instructions ?? "");
  }, [persona]);

  const estimatedTokens = useMemo(() => {
    return estimateTokens(instructions.length);
  }, [instructions]);

  const isCustom = useMemo(() => {
    const trimmedInstructions = instructions.trim();
    const defaultTrimmed = defaultPersona.instructions.trim();
    return (
      (trimmedInstructions.length > 0 && trimmedInstructions !== defaultTrimmed) ||
      (name.trim().length > 0 && name.trim() !== defaultPersona.name)
    );
  }, [name, instructions, defaultPersona]);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      const ok = await onSave({ name: name.trim(), instructions: instructions });
      if (ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2500);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsResetting(true);
    try {
      const ok = await onReset();
      if (ok) {
        setName(defaultPersona.name ?? "");
        setInstructions(defaultPersona.instructions);
      }
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <UserCircle className="size-5 text-muted-foreground" />
            <CardTitle>System Persona</CardTitle>
          </div>
          <Badge variant={isCustom ? "default" : "secondary"}>
            {isCustom ? "Custom Active" : "Default Yggdrasil"}
          </Badge>
        </div>
        <CardDescription>
          Customize your AI's global identity, tone, and behavioral instructions across all conversations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="persona-name">Persona Name (Optional)</FieldLabel>
            <Input
              id="persona-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Software Architect, Senior Researcher, or Yggdrasil"
              maxLength={100}
            />
            <FieldDescription>
              A descriptive title or name the assistant identifies as. Defaults to &quot;Yggdrasil&quot;.
            </FieldDescription>
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="persona-instructions">System Instructions</FieldLabel>
              <Badge variant="outline" className="text-xs font-mono">
                ~{estimatedTokens} tokens
              </Badge>
            </div>
            <Textarea
              id="persona-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={defaultPersona.instructions}
              rows={8}
              className="font-mono text-sm leading-relaxed"
              maxLength={10000}
            />
            <FieldDescription>
              Instructions defining the assistant&apos;s personality, expertise, formatting habits, or domain focus.
              Core tool invariants (web search, artifacts, tasks) strictly apply regardless of persona.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={handleSave}
              disabled={isSaving || isResetting}
            >
              {saveSuccess ? (
                <>
                  <Check className="size-4 text-success" />
                  Saved
                </>
              ) : (
                "Save Persona"
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleReset}
              disabled={isSaving || isResetting}
            >
              <ArrowCounterClockwise className="size-4" />
              Reset to Default
            </Button>
          </div>
          <span className="text-muted-foreground text-xs">
            Max 10,000 characters (~2,500 tokens)
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Update `SETTINGS_TABS` in `src/components/settings/shared.ts`**

Update `src/components/settings/shared.ts`:
```typescript
export const SETTINGS_TABS = [
  { value: "general", label: "General" },
  { value: "persona", label: "Persona" },
  { value: "provider", label: "Providers" },
  { value: "embedding", label: "Embedding" },
  { value: "database", label: "Database" },
  { value: "tools", label: "Tools" },
  { value: "about", label: "About" },
] as const;
```
And add to `SETTINGS_TAB_INTROS`:
```typescript
  persona:
    "Customize your assistant's personality, tone, role identity, and behavioral instructions.",
```

- [ ] **Step 5: Wire `PersonaTab` into `src/components/settings-view.tsx`**

In `src/components/settings-view.tsx`:
1. Import `PersonaTab` from `@/components/settings/persona-tab`.
2. Fetch persona data on mount from `/api/settings/persona`.
3. Add `TabsContent value="persona"` with `PersonaTab`.
4. Add save and reset handlers calling `/api/settings/persona` and `/api/settings/persona/reset`.

- [ ] **Step 6: Run tests and verify they pass**

Run: `pnpm vitest run src/components/__tests__/persona-settings-tab.test.tsx --maxWorkers=1`  
Expected: PASS (4/4 tests passing).

- [ ] **Step 7: Run full settings view test suite**

Run: `pnpm vitest run src/components/__tests__/settings-view.test.tsx --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/persona-tab.tsx src/components/settings/shared.ts src/components/settings-view.tsx src/components/__tests__/persona-settings-tab.test.tsx
git commit -m "feat(settings): add persona settings tab with live token estimation"
```

---

### Task 5: End-to-End Verification and Final Polish

**Files:**
- Test all touched files and verify full test suite passes.

- [ ] **Step 1: Run complete persona test suite**

Run:
```bash
pnpm vitest run src/lib/__tests__/persona-service.test.ts src/lib/ai/__tests__/prompt-persona.test.ts src/app/api/settings/persona/__tests__/route.test.ts src/components/__tests__/persona-settings-tab.test.tsx --maxWorkers=1
```
Expected: PASS across all test files.

- [ ] **Step 2: Run linter and type-checking**

Run:
```bash
pnpm lint
pnpm tsc --noEmit
```
Expected: PASS with 0 errors.

- [ ] **Step 3: Review git diff and commit**

```bash
git status
```
Verify only clean, intended changes exist.
