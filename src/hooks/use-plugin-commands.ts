"use client";

import { useCallback, useEffect, useState } from "react";

export type PluginCommand = {
  name: string;
  description: string | null;
  argumentHint: string | null;
  content: string;
  pluginName: string;
};

/**
 * Slash-commands contributed by enabled plugins. Fetched once per
 * mount; `expand` turns "/name args" into the command's template with
 * $ARGUMENTS substituted (Claude Code command semantics).
 */
export function usePluginCommands() {
  const [commands, setCommands] = useState<PluginCommand[]>([]);

  const refresh = useCallback(() => {
    let cancelled = false;
    fetch("/api/plugins/commands")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { commands?: PluginCommand[] } | null) => {
        if (!cancelled && data?.commands) setCommands(data.commands);
      })
      .catch(() => {
        // Commands are an enhancement; never block the chat on them.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  const expand = useCallback(
    (text: string): string => {
      const match = /^\/([a-z0-9:_-]+)[ \t]*([\s\S]*)$/i.exec(text.trim());
      if (!match) return text;
      const command = commands.find((c) => c.name === match[1]);
      if (!command) return text;
      const args = (match[2] ?? "").trim();
      if (command.content.includes("$ARGUMENTS")) {
        return command.content.replace(/\$ARGUMENTS/g, () => args);
      }
      return args ? `${command.content}\n\nARGUMENTS: ${args}` : command.content;
    },
    [commands]
  );

  return { commands, refresh, expand };
}
