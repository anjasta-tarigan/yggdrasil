"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CircleNotch,
  Eye,
  MagnifyingGlass,
  Sparkle,
  Storefront,
  Trash,
} from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useCallback, useMemo, useState } from "react";
import {
  sourceLabel,
  type SkillRow,
} from "@/components/skills/types";

/**
 * "Manage skills" tab — the installed skills list: filter, inspect
 * (file viewer dialog), toggle enablement, delete, and open the
 * creation wizard. Pure presentational over props; all fetching lives
 * in the parent SkillsView.
 */

type Props = {
  skills: SkillRow[];
  busyKey: string | null;
  onToggle: (skill: SkillRow, enabled: boolean) => void;
  onDelete: (skill: SkillRow) => void;
  onView: (skill: SkillRow) => void;
  onOpenMarketplace: () => void;
};

export function ManageSkillsTab({
  skills,
  busyKey,
  onToggle,
  onDelete,
  onView,
  onOpenMarketplace,
}: Props) {
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }, [filter, skills]);

  const enabledCount = useMemo(
    () => skills.filter((s) => s.enabled).length,
    [skills]
  );

  const ariaLabel = useCallback(
    (skill: SkillRow) => `Toggle ${skill.name}`,
    []
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-lg">
            Installed skills{" "}
            <span className="text-muted-foreground text-sm">
              ({skills.length})
            </span>
          </h2>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {enabledCount} enabled · enabled skills are listed in the
            assistant&apos;s system prompt and load on demand.
          </p>
        </div>
        {skills.length > 0 && (
          <div className="relative w-full sm:w-64">
            <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Filter installed skills"
              className="pl-8"
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter skills…"
              value={filter}
            />
          </div>
        )}
      </div>

      {skills.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
          <Sparkle className="size-8 text-muted-foreground/60" />
          <div>
            <p className="font-medium text-sm">No skills installed yet</p>
            <p className="mt-1 max-w-md text-muted-foreground text-xs">
              Browse ClawHub, skills.sh or any GitHub repo in the
              marketplace, or create a skill from scratch.
            </p>
          </div>
          <Button
            onClick={onOpenMarketplace}
            size="sm"
            type="button"
            variant="outline"
          >
            <Storefront className="size-4" />
            Open marketplace
          </Button>
        </div>
      )}

      {skills.length > 0 && visible.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No skills match “{filter.trim()}”.
        </p>
      )}

      {visible.length > 0 && (
        <ul className="space-y-2">
          {visible.map((skill) => (
            <li className="rounded-md border px-3 py-2" key={skill.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 font-medium text-sm">
                    {skill.name}
                    {skill.version && (
                      <Badge variant="secondary">{skill.version}</Badge>
                    )}
                    {skill.pluginId && (
                      <Badge variant="outline">plugin</Badge>
                    )}
                    {skill.enabled && (
                      <Badge className="border-transparent" variant="outline">
                        <span className="size-1.5 rounded-full bg-primary" />
                        enabled
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                    {skill.description}
                  </p>
                  <p className="mt-0.5 text-muted-foreground/70 text-[11px]">
                    {sourceLabel(skill)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    aria-label={`View ${skill.name} files`}
                    onClick={() => onView(skill)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Eye className="size-4" />
                  </Button>
                  <Button
                    aria-label={`Delete ${skill.name}`}
                    disabled={Boolean(skill.pluginId)}
                    onClick={() => onDelete(skill)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash className="size-4" />
                  </Button>
                  <Switch
                    aria-label={ariaLabel(skill)}
                    checked={skill.enabled}
                    onCheckedChange={(v) => onToggle(skill, v)}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {busyKey === "refresh" && (
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <CircleNotch className="size-3.5 animate-spin" />
          Refreshing…
        </p>
      )}
    </div>
  );
}
