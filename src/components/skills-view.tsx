"use client";

import { PageView } from "@/components/app-shell/page-view";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { ManageSkillsTab } from "@/components/skills/manage-skills-tab";
import { NewSkillWizard } from "@/components/skills/new-skill-wizard";
import { SkillMarketplaceTab } from "@/components/skills/skill-marketplace-tab";
import { SkillViewerDialog } from "@/components/skills/skill-viewer-dialog";
import type { SkillRow } from "@/components/skills/types";

/**
 * Skills page — two separated areas behind one shell:
 *   • Manage skills    — the installed set (enable, inspect, delete)
 *   • Skill marketplace — browse/install from ClawHub, skills.sh, GitHub
 *
 * Skills follow the agentskills.io format: enabled skills are listed
 * in the assistant's system prompt and their instructions load on
 * demand through the use_skill tool.
 *
 * Same in-shell layout contract as SettingsView / McpView; the tab bar
 * follows the Settings page pattern (horizontal — two segments fit
 * down to 360px, so no mobile Select fallback is needed).
 */

const SKILLS_TABS = [
  { value: "manage", label: "Manage skills" },
  { value: "marketplace", label: "Skill marketplace" },
] as const;

type SkillsTab = (typeof SKILLS_TABS)[number]["value"];

export function SkillsView({ onBack }: { onBack: () => void }) {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [activeTab, setActiveTab] = useState<SkillsTab>("manage");

  // Install/create state.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  // Viewer state.
  const [viewSkill, setViewSkill] = useState<SkillRow | null>(null);

  const refreshSkills = useCallback(() => {
    fetch("/api/skills")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = await res.json();
        setSkills(data.skills ?? []);
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    refreshSkills();
  }, [refreshSkills]);

  const install = useCallback(
    async (key: string, payload: Record<string, unknown>) => {
      setBusyKey(key);
      setNotice(null);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Install failed.");
        setNotice(`Installed skill “${data.skill?.name ?? key}”.`);
        refreshSkills();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Install failed");
      } finally {
        setBusyKey(null);
      }
    },
    [refreshSkills]
  );

  const toggleSkill = useCallback(
    async (skill: SkillRow, enabled: boolean) => {
      setSkills((prev) =>
        prev.map((s) => (s.id === skill.id ? { ...s, enabled } : s))
      );
      try {
        const res = await fetch(`/api/skills/${skill.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) throw new Error();
      } catch {
        setSkills((prev) =>
          prev.map((s) => (s.id === skill.id ? { ...s, enabled: !enabled } : s))
        );
      }
    },
    []
  );

  const deleteSkill = useCallback(
    async (skill: SkillRow) => {
      try {
        const res = await fetch(`/api/skills/${skill.id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Delete failed.");
        refreshSkills();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [refreshSkills]
  );

  const openViewer = useCallback((skill: SkillRow) => {
    setViewSkill(skill);
  }, []);

  return (
    <PageView
      actions={
        <Button
          onClick={() => setWizardOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="size-4" />
          New skill
        </Button>
      }
      onBack={onBack}
      title="Skills"
    >
      <p className="mb-4 mt-1 text-muted-foreground text-sm">
        Agent Skills are reusable instruction bundles (agentskills.io format).
        Manage the installed set, or browse the marketplace to add more.
        Ask the assistant to create a skill for you — it follows the official
        skill-creator workflow — or use the wizard.
      </p>

      {loadError && (
        <p className="mb-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          <Warning className="size-4 shrink-0" />
          Could not load skills from the server.
        </p>
      )}
      {notice && (
        <p className="mb-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      <Tabs
        className="gap-4"
        onValueChange={(value) => setActiveTab(value as SkillsTab)}
        value={activeTab}
      >
        <TabsList>
          {SKILLS_TABS.map((tab) => (
            <TabsTrigger
              className="px-3"
              key={tab.value}
              value={tab.value}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="manage">
          <ManageSkillsTab
            busyKey={busyKey}
            onDelete={(skill) => void deleteSkill(skill)}
            onOpenMarketplace={() => setActiveTab("marketplace")}
            onToggle={(skill, enabled) => void toggleSkill(skill, enabled)}
            onView={openViewer}
            skills={skills}
          />
        </TabsContent>

        <TabsContent value="marketplace">
          <SkillMarketplaceTab
            busyKey={busyKey}
            onInstall={(key, payload) => void install(key, payload)}
            skills={skills}
          />
        </TabsContent>
      </Tabs>

      <SkillViewerDialog
        onClose={() => setViewSkill(null)}
        skill={viewSkill}
      />

      <NewSkillWizard
        onClose={() => setWizardOpen(false)}
        onCreated={() => {
          setWizardOpen(false);
          refreshSkills();
        }}
        open={wizardOpen}
      />
    </PageView>
  );
}
