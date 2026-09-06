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
