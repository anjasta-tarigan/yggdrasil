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

/**
 * Strip non-printable ASCII control characters, keeping newlines, carriage
 * returns, tabs, and valid UTF-8.
 *
 * Used for `instructions`, which is legitimately multi-line.
 */
function sanitizeText(str: string): string {
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Normalizes a persona *name* to a single line.
 *
 * A name is rendered as `Assistant Identity: <name>` inside the prompt, so an
 * embedded newline would let it inject additional prompt lines (e.g. a fake
 * "Workspace Trust: trusted" or a forged directive). Collapsing all whitespace
 * runs to single spaces keeps the name on one line.
 */
function sanitizeName(str: string): string {
  return sanitizeText(str).replace(/\s+/g, " ");
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
  // Normalize on read as well as write: a row stored before name
  // sanitization existed could still carry a multi-line name.
  const trimmedName = sanitizeName(persona.name ?? "").trim();
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

  const cleanName = sanitizeName(parsed.name).trim();
  const cleanInstructions = sanitizeText(parsed.instructions).trim();

  const newPersona: SystemPersonaConfig = {
    name: cleanName.length > 0 ? cleanName : undefined,
    instructions: cleanInstructions,
    updatedAt: Date.now(),
  };

  await database
    .insert(settings)
    .values({
      key: SETTINGS_KEY,
      value: newPersona,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: newPersona,
        updatedAt: new Date(),
      },
    });

  return newPersona;
}

export async function resetSystemPersona(
  database: AppDatabase = defaultDb
): Promise<SystemPersonaConfig> {
  const resetPersona: SystemPersonaConfig = {
    ...DEFAULT_SYSTEM_PERSONA,
    updatedAt: Date.now(),
  };

  await database
    .insert(settings)
    .values({
      key: SETTINGS_KEY,
      value: resetPersona,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: resetPersona,
        updatedAt: new Date(),
      },
    });

  return resetPersona;
}
