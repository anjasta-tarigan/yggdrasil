"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CircleNotch, Plus, Trash, Warning } from "@phosphor-icons/react";
import { useState } from "react";
import type { WizardFile } from "@/components/skills/types";

/**
 * Manual creation wizard: writes a spec-valid SKILL.md (frontmatter
 * composed server-side) plus optional bundled files through
 * POST /api/skills.
 */
export function NewSkillWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
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
              placeholder={
                "Step-by-step guidance the assistant follows when this skill activates…"
              }
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
                    aria-label={`File ${index + 1} path`}
                    id={`file-path-${index}`}
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
                    aria-label={`Remove file ${index + 1}`}
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
                  aria-label={`File ${index + 1} content`}
                  className="min-h-20 font-mono text-xs"
                  id={`file-content-${index}`}
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
          <Button disabled={saving} onClick={() => void submit()} type="button">
            {saving && <CircleNotch className="size-4 animate-spin" />}
            Create skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
