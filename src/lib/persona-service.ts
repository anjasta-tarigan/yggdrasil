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

/** Strip non-printable ASCII control characters, keeping newlines, carriage returns, tabs, and valid UTF-8. */
function sanitizeText(str: string): string {
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
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
