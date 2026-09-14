/**
 * Built-in chat tools, one module per concern.
 *
 * Adding a new tool: create a file in this directory exporting a
 * `tool({...})` object, import it below, and add it to `builtinTools`.
 * No other file needs to change — `chatTools` in `src/lib/ai/tools.ts`
 * is derived from this registry.
 *
 * Built-ins take precedence over any same-named skill tool (the skill
 * layer spreads on top in `chatTools` but built-ins are spread last).
 */

import * as artifact from "./artifact";
import * as core from "./core";
import * as memory from "./memory";
import * as task from "./task";
import * as web from "./web";
import { file_operations } from "./files";
import { notify_user } from "./notify";
import { host_info } from "./system";
import { bash } from "./bash";

export const builtinTools = {
  ...web,
  ...task,
  ...core,
  ...artifact,
  ...memory,
  file_operations,
  notify_user,
  host_info,
  bash,
};
