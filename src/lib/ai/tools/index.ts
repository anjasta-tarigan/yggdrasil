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
import { image_search } from "./image";
import { file_operations } from "./files";
import { notify_user } from "./notify";
import { host_info } from "./system";
import { bash } from "./bash";
import { get_device_location } from "./location";
import {
  manage_cron_schedule,
  manage_custom_tool,
  manage_mcp_server,
  manage_subagent,
} from "./management";

export const builtinTools = {
  ...web,
  image_search,
  ...task,
  ...core,
  ...artifact,
  ...memory,
  file_operations,
  notify_user,
  host_info,
  bash,
  get_device_location,
  // ── Agent management: create/update/delete/list system entities
  //    at runtime. These wrap the existing service layer (cron-jobs-service,
  //    subagents-service, mcp/manager, custom-tools/service) — no API route or UI needed.
  manage_cron_schedule,
  manage_custom_tool,
  manage_mcp_server,
  manage_subagent,
};
