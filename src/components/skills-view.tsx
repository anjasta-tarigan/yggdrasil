"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  CircleNotch,
  DownloadSimple,
  Eye,
  MagicWand,
  Plus,
  Sparkle,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

/**
 * Skills page — install Agent Skills (agentskills.io) from ClawHub,
 * skills.sh or any GitHub repo, create them manually, and manage the
 * installed set. Installed skills are listed in the system prompt and
 * load on demand through the assistant's use_skill tool.
 *
 * Same in-shell layout contract as SettingsView / McpView.
 */

type SkillRow = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  enabled: boolean;
  pluginId: string | null;
  source?: { kind?: string; [key: string]: unknown } | null;
};

type ClawHubResult = {
  slug: string;
  displayName?: string;
  summary?: string;
  version?: string;
  ownerHandle?: string;
  downloads?: number;
};

type SkillsShResult = {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
};

type GithubSkillEntry = { name: string; dirPath: string };

type RegistryTab = "clawhub" | "skillssh" | "github";

type WizardFile = { path: string; content: string };

function sourceLabel(skill: SkillRow): string {
  const src = skill.source ?? {};
  switch (src.kind) {
    case "clawhub":
      return `ClawHub · ${String(src.slug ?? "")}`;
    case "skillssh":
      return `skills.sh · ${String(src.id ?? "")}`;
    case "github":
      return `GitHub · ${String(src.owner ?? "")}/${String(src.repo ?? "")}`;
    case "plugin":
      return `Plugin · ${String(src.plugin ?? "")}`;
    case "builtin":
      return "Built-in";
    default:
      return "Local";
  }
}

export function SkillsView({ onBack }: { onBack: () => void }) {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loadError, setLoadError] = useState(false);

  // Search state.
  const [tab, setTab] = useState<RegistryTab>("clawhub");
  const [query, setQuery] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubSkills, setGithubSkills] = useState<GithubSkillEntry[] | null>(null);
  const [results, setResults] = useState<Array<ClawHubResult | SkillsShResult>>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Install/create state.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  // Viewer state.
  const [viewSkill, setViewSkill] = useState<SkillRow | null>(null);
  const [viewFiles, setViewFiles] = useState<string[]>([]);
  const [viewFile, setViewFile] = useState<{ path: string; content: string } | null>(null);

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

  const runSearch = useCallback(async () => {
    setSearchError(null);
    setResults([]);
    setGithubSkills(null);

    if (tab === "github") {
      const repo = githubRepo.trim();
      if (!repo) return;
      setSearching(true);
      try {
        const res = await fetch(
          `/api/skills/search?registry=github&repo=${encodeURIComponent(repo)}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to list repo skills.");
        setGithubSkills(data.skills ?? []);
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setSearching(false);
      }
      return;
    }

    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    try {
      const res = await fetch(
        `/api/skills/search?registry=${tab}&q=${encodeURIComponent(q)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      setResults(data.results ?? []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, [githubRepo, query, tab]);

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
        setSearchError(err instanceof Error ? err.message : "Install failed");
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

  const openViewer = useCallback(async (skill: SkillRow) => {
    setViewSkill(skill);
    setViewFile(null);
    try {
      const res = await fetch(`/api/skills/${skill.id}/files`);
      const data = await res.json();
      setViewFiles(data.files ?? []);
    } catch {
      setViewFiles([]);
    }
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      if (!viewSkill) return;
      try {
        const res = await fetch(
          `/api/skills/${viewSkill.id}/files?path=${encodeURIComponent(path)}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Read failed.");
        setViewFile({ path, content: data.content });
      } catch (err) {
        setViewFile({
          path,
          content: `// ${err instanceof Error ? err.message : "Could not read file."}`,
        });
      }
    },
    [viewSkill]
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ArrowLeft className="size-4" />
            Back to chat
          </Button>
          <Button onClick={() => setWizardOpen(true)} size="sm" type="button" variant="outline">
            <Plus className="size-4" />
            New skill
          </Button>
        </div>

        <div className="mb-4">
          <h1 className="flex items-center gap-2 font-semibold text-xl">
            <Sparkle className="size-5 text-primary" />
            Skills
          </h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Agent Skills are reusable instruction bundles (agentskills.io
            format). Enabled skills are listed in the assistant&apos;s system
            prompt; the full instructions load on demand when a task matches.
            Ask the assistant to create a skill for you — it follows the
            official skill-creator workflow — or use the wizard.
          </p>
        </div>

        {loadError && (
          <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            Could not load skills from the server.
          </p>
        )}
        {notice && (
          <p className="mb-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
            {notice}
          </p>
        )}

        {/* ── Install from registries ─────────────────────────── */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Install from a registry</CardTitle>
            <CardDescription>
              Third-party skills are instructions written by their authors —
              review the SKILL.md after installing. Suspicious ClawHub skills
              are hidden automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["clawhub", "ClawHub"],
                  ["skillssh", "skills.sh"],
                  ["github", "GitHub repo"],
                ] as Array<[RegistryTab, string]>
              ).map(([value, label]) => (
                <Button
                  key={value}
                  onClick={() => {
                    setTab(value);
                    setResults([]);
                    setGithubSkills(null);
                    setSearchError(null);
                  }}
                  size="sm"
                  type="button"
                  variant={tab === value ? "default" : "outline"}
                >
                  {label}
                </Button>
              ))}
            </div>

            {tab !== "github" ? (
              <div className="flex gap-2">
                <Input
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runSearch();
                  }}
                  placeholder={
                    tab === "clawhub"
                      ? "Search ClawHub skills…"
                      : "Search skills.sh…"
                  }
                  value={query}
                />
                <Button
                  disabled={searching || query.trim().length < 2}
                  onClick={() => void runSearch()}
                  type="button"
                >
                  {searching ? (
                    <CircleNotch className="size-4 animate-spin" />
                  ) : (
                    "Search"
                  )}
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  onChange={(e) => setGithubRepo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runSearch();
                  }}
                  placeholder="owner/repo or github.com URL (e.g. anthropics/skills)"
                  value={githubRepo}
                />
                <Button
                  disabled={searching || !githubRepo.trim()}
                  onClick={() => void runSearch()}
                  type="button"
                >
                  {searching ? (
                    <CircleNotch className="size-4 animate-spin" />
                  ) : (
                    "List skills"
                  )}
                </Button>
              </div>
            )}

            {searchError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
                {searchError}
              </p>
            )}

            {/* ClawHub / skills.sh results */}
            {results.length > 0 && (
              <ul className="space-y-2">
                {results.map((r) => {
                  const isClawHub = tab === "clawhub";
                  const key = isClawHub
                    ? `clawhub:${(r as ClawHubResult).slug}`
                    : `skillssh:${(r as SkillsShResult).id}`;
                  const title = isClawHub
                    ? ((r as ClawHubResult).displayName ?? (r as ClawHubResult).slug)
                    : (r as SkillsShResult).name;
                  const summary = isClawHub
                    ? (r as ClawHubResult).summary
                    : (r as SkillsShResult).source;
                  const count = isClawHub
                    ? (r as ClawHubResult).downloads
                    : (r as SkillsShResult).installs;
                  return (
                    <li
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                      key={key}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-sm">
                          {title}
                          {isClawHub && (r as ClawHubResult).ownerHandle && (
                            <span className="ml-1 text-muted-foreground">
                              @{(r as ClawHubResult).ownerHandle}
                            </span>
                          )}
                        </p>
                        {summary && (
                          <p className="truncate text-muted-foreground text-xs">
                            {summary}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {typeof count === "number" && (
                          <span className="text-muted-foreground text-xs">
                            {count.toLocaleString()} installs
                          </span>
                        )}
                        <Button
                          disabled={busyKey !== null}
                          onClick={() =>
                            isClawHub
                              ? void install(key, {
                                  registry: "clawhub",
                                  ref: `${(r as ClawHubResult).ownerHandle ? `@${(r as ClawHubResult).ownerHandle}/` : ""}${(r as ClawHubResult).slug}`,
                                })
                              : void install(key, {
                                  registry: "skillssh",
                                  id: (r as SkillsShResult).id,
                                  source: (r as SkillsShResult).source,
                                  skillId: (r as SkillsShResult).skillId,
                                })
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {busyKey === key ? (
                            <CircleNotch className="size-4 animate-spin" />
                          ) : (
                            <DownloadSimple className="size-4" />
                          )}
                          Install
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* GitHub repo skill picker */}
            {githubSkills !== null && (
              <ul className="space-y-2">
                {githubSkills.length === 0 && (
                  <li className="text-muted-foreground text-sm">
                    No SKILL.md folders found in that repository.
                  </li>
                )}
                {githubSkills.map((entry) => {
                  const key = `github:${githubRepo}:${entry.dirPath}`;
                  return (
                    <li
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                      key={key}
                    >
                      <p className="truncate font-medium text-sm">{entry.name}</p>
                      <Button
                        disabled={busyKey !== null}
                        onClick={() =>
                          void install(key, {
                            registry: "github",
                            repo: githubRepo.trim(),
                            path: entry.dirPath || undefined,
                          })
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {busyKey === key ? (
                          <CircleNotch className="size-4 animate-spin" />
                        ) : (
                          <DownloadSimple className="size-4" />
                        )}
                        Install
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex items-center gap-2 border-t pt-3">
              <MagicWand className="size-4 text-muted-foreground" />
              <p className="text-muted-foreground text-xs">
                Skill creator: install Anthropic&apos;s official{" "}
                <button
                  className="underline underline-offset-2 hover:text-foreground"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void install("builtin:skill-creator", {
                      registry: "github",
                      repo: "anthropics/skills",
                      path: "skills/skill-creator",
                    })
                  }
                  type="button"
                >
                  skill-creator
                </button>{" "}
                and then ask the assistant to build a new skill for you.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Installed skills ────────────────────────────────── */}
        <h2 className="mb-2 font-semibold text-lg">
          Installed skills{" "}
          <span className="text-muted-foreground text-sm">({skills.length})</span>
        </h2>
        {skills.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing installed yet. Search a registry above or create a skill.
          </p>
        ) : (
          <ul className="space-y-2">
            {skills.map((skill) => (
              <li className="rounded-md border px-3 py-2" key={skill.id}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium text-sm">
                      {skill.name}
                      {skill.version && (
                        <Badge variant="secondary">{skill.version}</Badge>
                      )}
                      {skill.pluginId && (
                        <Badge variant="outline">plugin</Badge>
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
                      onClick={() => void openViewer(skill)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Eye className="size-4" />
                    </Button>
                    <Button
                      disabled={Boolean(skill.pluginId)}
                      onClick={() => void deleteSkill(skill)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash className="size-4" />
                    </Button>
                    <Switch
                      checked={skill.enabled}
                      onCheckedChange={(v) => void toggleSkill(skill, v)}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* ── Skill content viewer ────────────────────────────── */}
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setViewSkill(null);
              setViewFile(null);
            }
          }}
          open={viewSkill !== null}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{viewSkill?.name}</DialogTitle>
              <DialogDescription>
                {viewSkill ? sourceLabel(viewSkill) : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 gap-3">
              <ul className="w-44 shrink-0 space-y-1 overflow-y-auto text-sm">
                {viewFiles.map((file) => (
                  <li key={file}>
                    <button
                      className={`w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted ${
                        viewFile?.path === file ? "bg-muted font-medium" : ""
                      }`}
                      onClick={() => void openFile(file)}
                      type="button"
                    >
                      {file}
                    </button>
                  </li>
                ))}
              </ul>
              <pre className="max-h-[50vh] min-w-0 flex-1 overflow-auto rounded-md bg-muted p-3 text-xs">
                {viewFile
                  ? viewFile.content
                  : "Select a file to preview its content."}
              </pre>
            </div>
          </DialogContent>
        </Dialog>

        <NewSkillWizard
          onClose={() => setWizardOpen(false)}
          onCreated={() => {
            setWizardOpen(false);
            refreshSkills();
          }}
          open={wizardOpen}
        />
      </div>
    </div>
  );
}

/* ── Manual creation wizard ──────────────────────────────────────── */

function NewSkillWizard({
  onClose,
  onCreated,
  open,
}: {
  onClose: () => void;
  onCreated: () => void;
  open: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<WizardFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const nameValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64;

  const reset = () => {
    setName("");
    setDescription("");
    setContent("");
    setFiles([]);
    setError(null);
    setSaving(false);
  };

  const submit = async () => {
    setError(null);
    if (!nameValid) {
      setError(
        "Name must be lowercase letters, digits and hyphens (no leading/trailing/consecutive hyphens, max 64 chars)."
      );
      return;
    }
    if (!description.trim() || description.length > 1024) {
      setError("Description is required (max 1024 characters).");
      return;
    }
    if (!content.trim()) {
      setError("Instructions are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description.trim(),
          content,
          files: files.filter((f) => f.path.trim() && f.content),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Create failed.");
      reset();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
      setSaving(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          reset();
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            Create a skill following the agentskills.io spec. The description
            is what the model sees at startup — state what the skill does and
            when to use it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="skill-name">
                Name
              </label>
              <Input
                id="skill-name"
                onChange={(e) => setName(e.target.value)}
                placeholder="weekly-report"
                value={name}
              />
              {name && !nameValid && (
                <p className="text-destructive text-xs">
                  Lowercase letters, digits and single hyphens only.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="skill-description">
                Description ({description.length}/1024)
              </label>
              <Input
                id="skill-description"
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What it does and when to use it"
                value={description}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="skill-content">
              Instructions (SKILL.md body)
            </label>
            <Textarea
              className="min-h-40 font-mono text-xs"
              id="skill-content"
              onChange={(e) => setContent(e.target.value)}
              placeholder={"Step-by-step guidance the assistant follows when this skill activates…"}
              value={content}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">
                Bundled files (optional)
              </span>
              <Button
                onClick={() => setFiles((f) => [...f, { path: "", content: "" }])}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Plus className="size-3.5" />
                Add file
              </Button>
            </div>
            {files.map((file, index) => (
              <div className="space-y-1 rounded-md border p-2" key={index}>
                <div className="flex gap-2">
                  <Input
                    onChange={(e) =>
                      setFiles((prev) =>
                        prev.map((f, i) =>
                          i === index ? { ...f, path: e.target.value } : f
                        )
                      )
                    }
                    placeholder="references/checklist.md"
                    value={file.path}
                  />
                  <Button
                    onClick={() =>
                      setFiles((prev) => prev.filter((_, i) => i !== index))
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash className="size-4" />
                  </Button>
                </div>
                <Textarea
                  className="min-h-20 font-mono text-xs"
                  onChange={(e) =>
                    setFiles((prev) =>
                      prev.map((f, i) =>
                        i === index ? { ...f, content: e.target.value } : f
                      )
                    )
                  }
                  placeholder="File content…"
                  value={file.content}
                />
              </div>
            ))}
          </div>

          {error && (
            <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
              <Warning className="size-4 shrink-0" />
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => void submit()}
            type="button"
          >
            {saving && <CircleNotch className="size-4 animate-spin" />}
            Create skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
