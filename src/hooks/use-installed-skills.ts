"use client";

import { useCallback, useEffect, useState } from "react";

export interface InstalledSkillSummary {
  id: string;
  name: string;
  enabled: boolean;
}

/**
 * Hook to retrieve the list of installed and enabled skills.
 * Used by chat components to adaptively display tool/skill badges (e.g. anti-slop).
 */
export function useInstalledSkills() {
  const [skills, setSkills] = useState<InstalledSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    let cancelled = false;
    fetch("/api/skills")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { skills?: InstalledSkillSummary[] } | null) => {
        if (!cancelled && data?.skills) {
          setSkills(data.skills);
        }
      })
      .catch(() => {
        // Soft fallback: skills are enhancement, never block chat UI
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return refresh();
  }, [refresh]);

  const hasEnabledSkill = useCallback(
    (skillName: string): boolean => {
      const target = skillName.toLowerCase().trim();
      return skills.some(
        (s) => s.enabled && s.name.toLowerCase().trim() === target
      );
    },
    [skills]
  );

  return {
    skills,
    loading,
    hasEnabledSkill,
    refresh,
  };
}
