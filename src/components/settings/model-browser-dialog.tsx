"use client";

import React, { useState, useEffect, useRef } from "react";
import { syslog } from "@/lib/observability/log-store";
import { DownloadSimple, MagnifyingGlass, Pause, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatBytes } from "@/components/settings/shared";
import type { ModelKind, HfSearchResult } from "@/lib/models/types";
import type { InstallPlan, PlanFileItem } from "@/lib/models/installer";

type View = "search" | "inspect" | "installing";

interface ModelBrowserDialogProps {
  kind: ModelKind;
  onInstalled: () => void;
}

export function ModelBrowserDialog({ kind, onInstalled }: ModelBrowserDialogProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<HfSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [view, setView] = useState<View>("search");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<{
    status: string;
    bytesDownloaded: number;
    estimatedBytes: number;
    currentFile?: string;
    error?: string;
  } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Clear any active poll interval on unmount to prevent leaks.
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  function reset() {
    setSearchQuery("");
    setSearchResults([]);
    setSelectedRepo(null);
    setPlan(null);
    setView("search");
    setJobId(null);
    setJobStatus(null);
    setSearching(false);
    setInspecting(false);
    setInstalling(false);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function handleOpenChange(value: boolean) {
    setOpen(value);
    if (!value) reset();
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/models/search?q=${encodeURIComponent(searchQuery)}&kind=${kind}`);
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      const data = await res.json();
      setSearchResults(data.results ?? []);
    } catch (err) {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function handleInspect(repo: string) {
    setSelectedRepo(repo);
    setInspecting(true);
    setView("inspect");
    try {
      const res = await fetch("/api/models/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, kind }),
      });
      if (!res.ok) throw new Error(`Inspect failed: ${res.status}`);
      const data = await res.json();
      setPlan(data.plan);
    } catch {
      setPlan(null);
    } finally {
      setInspecting(false);
    }
  }

  async function handleInstall() {
    if (!plan) return;
    setInstalling(true);
    setView("installing");
    try {
      const res = await fetch("/api/models/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: plan.repo, kind }),
      });
      if (!res.ok) throw new Error(`Install failed: ${res.status}`);
      const data = await res.json();
      setJobId(data.jobId);
      startPolling(data.jobId);
    } catch (err) {
      setJobStatus({
        status: "failed",
        bytesDownloaded: 0,
        estimatedBytes: plan.totalBytes,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInstalling(false);
    }
  }

  async function cancelInstall() {
    if (!jobId) return;
    try {
      await fetch(`/api/models/install/${jobId}`, { method: "DELETE" });
    } catch (err) {
      syslog("warn", "ModelBrowserDialog", `cancel request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setJobStatus({
      status: "aborted",
      bytesDownloaded: 0,
      estimatedBytes: 0,
    });
  }

  function startPolling(id: string) {
    const poll = async () => {
      try {
        const res = await fetch(`/api/models/install/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        setJobStatus({
          status: data.status,
          bytesDownloaded: data.bytesDownloaded ?? 0,
          estimatedBytes: data.estimatedBytes ?? 0,
          currentFile: data.currentFile,
          error: data.error,
        });

        if (data.status === "completed") {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setJobId(null);
          setView("search");
          setSearchResults([]);
          setOpen(false);
          onInstalled();
        } else if (data.status === "failed" || data.status === "aborted") {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        } else {
          pollRef.current = setInterval(poll, 1500);
        }
      } catch {
        // Retry on network blip.
        pollRef.current = setInterval(poll, 1500);
      }
    };
    poll();
  }

  function renderFileRow(file: PlanFileItem) {
    const roleIcons: Record<string, JSX.Element> = {
      graph: <DownloadSimple className="size-3" />,
      "graph-data": <DownloadSimple className="size-3" />,
      tokenizer: <DownloadSimple className="size-3" />,
      pooling: <DownloadSimple className="size-3" />,
      companion: <DownloadSimple className="size-3" />,
    };
    return (
      <li key={file.destinationRelPath} className="flex justify-between gap-2 text-sm">
        <span className="flex items-center gap-1">
          {roleIcons[file.role] ?? <X className="size-3" />}
          <code className="font-mono text-xs">{file.destinationRelPath}</code>
        </span>
        <span className="text-muted-foreground font-mono text-xs">
          {formatBytes(file.sizeBytes)}
        </span>
      </li>
    );
  }

  function renderSearchView() {
    return (
      <>
        <div>
          <Input
            type="text"
            placeholder="Search HuggingFace models..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={searching}
          />
          <Button onClick={handleSearch} disabled={searching || !searchQuery.trim()} size="sm" variant="outline">
            {searching ? (
              <MagnifyingGlass className="size-4 animate-pulse" />
            ) : (
              <MagnifyingGlass className="size-4" />
            )}
            Search
          </Button>
        </div>
        {searchResults.length > 0 && (
          <ul className="space-y-2 max-h-64 overflow-y-auto">
            {searchResults.map((model) => (
              <li key={model.id} className="border rounded p-2">
                <div className="flex justify-between items-start">
                  <code className="font-mono text-sm">{model.id}</code>
                  <Button size="sm" variant="secondary" onClick={() => handleInspect(model.id)}>
                    Inspect
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">
                  {model.downloads}↓ {model.likes}★
                </div>
              </li>
            ))}
          </ul>
        )}
        {searchResults.length === 0 && !searching && (
          <p className="text-xs text-muted-foreground">
            Enter a search term and click Search to browse models.
          </p>
        )}
      </>
    );
  }

  function renderInspectView() {
    if (!plan) {
      return (
        <div className="py-4 text-center text-muted-foreground">
          Analyzing model...
        </div>
      );
    }

    const poolingLabel = plan.poolingSourceRepo
      ? `mean (from base model ${plan.poolingSourceRepo})`
      : "mean";

    return (
      <div className="space-y-4">
        <div>
          <span className="font-medium text-sm">Variant:</span>
          <span className="ml-2 font-mono text-sm">{plan.chosenVariant}</span>
        </div>
        <div>
          <span className="font-medium text-sm">Pooling:</span>
          <span className="ml-2 text-sm">{poolingLabel}</span>
        </div>
        <div>
          <span className="font-medium text-sm">Total size:</span>
          <span className="ml-2 text-sm">{formatBytes(plan.totalBytes)}</span>
        </div>
        <div>
          <span className="font-medium text-sm">Files ({plan.files.length}):</span>
          <ul className="mt-1 space-y-1">
            {plan.files.map(renderFileRow)}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setView("search")}>
            Back
          </Button>
          <Button size="sm" onClick={handleInstall} disabled={installing}>
            {installing ? "Installing…" : "Install"}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  function renderInstallingView() {
    const pct = jobStatus && jobStatus.estimatedBytes > 0
      ? Math.round((jobStatus.bytesDownloaded / jobStatus.estimatedBytes) * 100)
      : 0;

    return (
      <div className="space-y-4 py-4">
        <div>
          <div className="flex justify-between text-sm">
            <span>{jobStatus?.currentFile ?? "Preparing…"}</span>
            <Badge variant={jobStatus?.status === "failed" || jobStatus?.status === "aborted" ? "destructive" : "secondary"}>
              {jobStatus?.status ?? "pending"}
            </Badge>
          </div>
          <Progress value={pct} className="mt-2 h-2" />
          <div className="mt-1 text-xs text-muted-foreground">
            {formatBytes(jobStatus?.bytesDownloaded ?? 0)} / {formatBytes(jobStatus?.estimatedBytes ?? 0)}
          </div>
        </div>
        {jobStatus?.error && (
          <p className="text-xs text-destructive">{jobStatus.error}</p>
        )}
        {pollRef.current !== null && (
          <Button variant="outline" size="sm" onClick={cancelInstall}>
            <Pause className="size-4" /> Cancel
          </Button>
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <DownloadSimple className="size-4" />
          Add Model
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Browse models ({kind})</DialogTitle>
          <DialogDescription>
            Search and install ONNX models from HuggingFace.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          {view === "search" && renderSearchView()}
          {view === "inspect" && renderInspectView()}
          {view === "installing" && renderInstallingView()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
