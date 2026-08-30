import { createSkillTools } from "@/lib/skills/catalog";
import { builtinTools } from "./tools/index";

/**
 * Server-side tools available to the chat model.
 *
 * Built-in tools live in `./tools/`, one module per concern (web, task,
 * memory, artifact, core). Add a new tool by creating a file there and
 * registering it in `./tools/index.ts` — see that file for details.
 *
 * Skill runtime + authoring tools come from `createSkillTools()`.
 * Built-ins take precedence over any same-named skill tool (spread
 * last), so a buggy or malicious skill can never shadow a built-in.
 */

export const chatTools = {
  ...createSkillTools(),
  ...builtinTools,
};
