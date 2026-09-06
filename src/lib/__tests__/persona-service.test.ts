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
