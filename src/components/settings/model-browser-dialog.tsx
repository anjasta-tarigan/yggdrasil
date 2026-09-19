"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  CaretDown,
  CircleNotch,
  DownloadSimple,
  MagnifyingGlass,
  Pause,
  X,
} from "@phosphor-icons/react";
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
import type { InstallJob } from "@/lib/models/jobs";

type View = "search" | "inspect" | "installing";

/** Models fetched per page in browse mode; "Show more" steps by this amount. */
const BROWSE_PAGE_SIZE = 60;
/** Upper bound mirroring the search route's clamp. */
const BROWSE_MAX = 200;

interface ModelBrowserDialogProps {
  kind: ModelKind;
  onInstalled: (repo?: string) => void;
}

const EMBEDDING_SUGGESTIONS = [
  "Xenova/all-MiniLM-L6-v2",
  "BAAI/bge-small-en-v1.5",
  "Xenova/multilingual-e5-small",
  "nomic-ai/nomic-embed-text-v1.5",
];

const RERANKER_SUGGESTIONS = [
  "BAAI/bge-reranker-v2-m3",
  "BAAI/bge-reranker-base",
  "BAAI/bge-reranker-large",
];

export function ModelBrowserDialog({ kind, onInstalled }: ModelBrowserDialogProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<HfSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [view, setView] = useState<View>("search");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<{
    status: InstallJob["status"];
    bytesDownloaded: number;
    estimatedBytes: number;
    currentFile?: string;
    error?: string;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [browseLimit, setBrowseLimit] = useState(BROWSE_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  // Clear any active poll timer on unmount to prevent leaks.
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  function reset() {
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
    setInspectError(null);
    setPlan(null);
    setView("search");
    setJobId(null);
    setJobStatus(null);
    setSearching(false);
    setInstalling(false);
    setBrowseLimit(BROWSE_PAGE_SIZE);
    setHasMore(false);
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }

  function handleOpenChange(value: boolean) {
    setOpen(value);
    if (value) {
      // Preload the ranked catalog so the market shows the best ONNX models
      // immediately instead of an empty prompt. Fired from the open handler
      // rather than an effect: this is a user-initiated event, not a
      // state-synchronization side effect.
      if (searchResults.length === 0 && !searching) {
        void executeSearch(searchQuery);
      }
    } else {
      reset();
    }
  }

  async function executeSearch(query: string, limit?: number) {
    const seq = ++searchSeqRef.current;
    const isBrowse = !query.trim();
    // Browse mode pages through the ranked catalog; a real query does not.
    const effectiveLimit = isBrowse ? (limit ?? browseLimit) : undefined;
    setSearching(true);
    setSearchError(null);
    try {
      // An empty query browses the ranked ONNX catalog rather than returning nothing.
      const params = new URLSearchParams({ q: query.trim(), kind });
      if (effectiveLimit) params.set("limit", String(effectiveLimit));
      const res = await fetch(`/api/models/search?${params.toString()}`);
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      const data = await res.json();
      if (seq === searchSeqRef.current) {
        const results: HfSearchResult[] = data.results ?? [];
        setSearchResults(results);
        if (isBrowse && effectiveLimit) {
          setBrowseLimit(effectiveLimit);
          // A full page means there are likely more models behind it.
          setHasMore(results.length >= effectiveLimit && effectiveLimit < BROWSE_MAX);
        } else {
          setHasMore(false);
        }
      }
    } catch (err) {
      if (seq === searchSeqRef.current) {
        setSearchResults([]);
        setHasMore(false);
        setSearchError(err instanceof Error ? err.message : "Search request failed");
      }
    } finally {
      if (seq === searchSeqRef.current) {
        setSearching(false);
      }
    }
  }

  async function handleSearch() {
    // A fresh submit restarts paging from the first page.
    setBrowseLimit(BROWSE_PAGE_SIZE);
    await executeSearch(searchQuery, BROWSE_PAGE_SIZE);
  }

  async function handleShowMore() {
    const next = Math.min(browseLimit + BROWSE_PAGE_SIZE, BROWSE_MAX);
    await executeSearch("", next);
  }

  async function handleSuggestionClick(repo: string) {
    setSearchQuery(repo);
    await executeSearch(repo);
  }

  async function handleInspect(repo: string) {
    setView("inspect");
    setInspectError(null);
    setPlan(null);
    try {
      const res = await fetch("/api/models/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, kind }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Inspect failed: ${res.status}`);
      }
      const data = await res.json();
      setPlan(data.plan);
    } catch (err) {
      setPlan(null);
      setInspectError(err instanceof Error ? err.message : "Failed to analyze repository");
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
      startPolling(data.jobId, plan.repo);
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
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    if (!jobId) return;
    try {
      await fetch(`/api/models/install/${jobId}`, { method: "DELETE" });
    } catch (err) {
      console.warn("cancel request failed:", err instanceof Error ? err.message : String(err));
    }
    setJobStatus({
      status: "aborted",
      bytesDownloaded: 0,
      estimatedBytes: 0,
    });
  }

  function startPolling(id: string, installedRepo?: string) {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/models/install/${id}`);
        if (!res.ok) {
          if (res.status === 404) {
            setJobStatus({
              status: "failed",
              bytesDownloaded: 0,
              estimatedBytes: 0,
              error: "Installation job not found",
            });
            pollRef.current = null;
            return;
          }
          pollRef.current = setTimeout(poll, 1500);
          return;
        }
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
            clearTimeout(pollRef.current);
            pollRef.current = null;
          }
          const repoName = installedRepo ?? plan?.repo;
          setJobId(null);
          setView("search");
          setSearchResults([]);
          setOpen(false);
          onInstalled(repoName);
        } else if (data.status === "failed" || data.status === "aborted") {
          if (pollRef.current) {
            clearTimeout(pollRef.current);
            pollRef.current = null;
          }
        } else {
          pollRef.current = setTimeout(poll, 1500);
        }
      } catch (err) {
        console.debug(`[model-browser-dialog] Error: ${err instanceof Error ? err.message : String(err)}`);
        // Retry on network blip.
        pollRef.current = setTimeout(poll, 1500);
      }
    };
    poll();
  }

  function renderFileRow(file: PlanFileItem) {
    return (
      <li
        key={file.destinationRelPath}
        className="flex items-center justify-between gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5 text-xs min-w-0 overflow-hidden"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <DownloadSimple className="size-3.5 shrink-0 text-muted-foreground" />
          <code
            className="truncate font-mono text-[11px] text-foreground"
            title={file.destinationRelPath}
          >
            {file.destinationRelPath}
          </code>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {formatBytes(file.sizeBytes)}
        </span>
      </li>
    );
  }

  const suggestions = kind === "embedding" ? EMBEDDING_SUGGESTIONS : RERANKER_SUGGESTIONS;

  function renderSearchView() {
    return (
      <div className="space-y-4 min-w-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSearch();
          }}
          className="space-y-2.5 min-w-0"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="relative flex-1 min-w-0">
              <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                type="text"
                placeholder={
                  kind === "embedding"
                    ? "Filter ONNX embedding models (e.g. bge-small, all-MiniLM)…"
                    : "Filter ONNX reranker models (e.g. bge-reranker)…"
                }
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                disabled={searching}
                className="pl-9 pr-8 h-9 text-xs w-full"
              />
              {searchQuery.length > 0 && !searching && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded-sm transition-colors"
                  aria-label="Clear input"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <Button
              type="submit"
              disabled={searching}
              size="sm"
              className="h-9 px-4 shrink-0 font-medium"
            >
              {searching ? (
                <>
                  <CircleNotch className="size-4 animate-spin mr-1.5" />
                  Searching…
                </>
              ) : (
                <>
                  <MagnifyingGlass className="size-4 mr-1.5" />
                  Search
                </>
              )}
            </Button>
          </div>

          {/* Quick suggestions */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 min-w-0">
            <span className="text-[11px] font-medium text-muted-foreground mr-1 shrink-0">
              Suggested:
            </span>
            {suggestions.map((item) => (
              <button
                key={item}
                type="button"
                disabled={searching}
                onClick={() => void handleSuggestionClick(item)}
                className="inline-flex items-center rounded-md border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted hover:text-foreground disabled:opacity-50 shrink-0 max-w-full truncate"
              >
                {item}
              </button>
            ))}
          </div>
        </form>

        {searchError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
            {searchError}
          </div>
        )}

        {searchResults.length > 0 && (
          <div className="space-y-2 min-w-0">
            <div className="flex items-center justify-between text-xs text-muted-foreground px-0.5">
              <span>
                {searchQuery.trim()
                  ? `Results (${searchResults.length})`
                  : `Top ONNX models by downloads (${searchResults.length}${hasMore ? "+" : ""})`}
              </span>
              <span className="text-[10px]">ranked · ONNX only</span>
            </div>
            <ul className="max-h-60 space-y-2 overflow-y-auto overflow-x-hidden pr-1 min-w-0">
              {searchResults.map((model) => (
                <li
                  key={model.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-muted/30 min-w-0 overflow-hidden"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {typeof model.rank === "number" && (
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                          #{model.rank}
                        </span>
                      )}
                      <p
                        className="truncate font-mono text-xs font-semibold text-foreground"
                        title={model.id}
                      >
                        {model.id}
                      </p>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{model.downloads.toLocaleString()} downloads</span>
                      <span>•</span>
                      <span>{model.likes.toLocaleString()} likes</span>
                      {model.variants && model.variants.length > 0 && (
                        <>
                          <span>•</span>
                          <span title={model.variants.join(", ")}>
                            {model.variants.length} ONNX variant
                            {model.variants.length === 1 ? "" : "s"}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void handleInspect(model.id)}
                    className="shrink-0"
                  >
                    Inspect
                  </Button>
                </li>
              ))}
            </ul>
            {hasMore && (
              <div className="flex justify-center pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={searching}
                  onClick={() => void handleShowMore()}
                >
                  {searching ? (
                    <>
                      <CircleNotch className="size-3.5 animate-spin mr-1.5" />
                      Loading…
                    </>
                  ) : (
                    <>
                      <CaretDown className="size-3.5 mr-1.5" />
                      Show more models
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}

        {searchError && !searching && searchResults.length === 0 && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" onClick={() => void executeSearch(searchQuery)}>
              <ArrowClockwise className="size-3.5 mr-1.5" />
              Retry
            </Button>
          </div>
        )}

        {searchResults.length === 0 && !searching && !searchError && (
          <div className="rounded-lg border border-dashed border-border/70 p-6 text-center">
            <MagnifyingGlass className="mx-auto size-7 text-muted-foreground/60 mb-2" />
            <p className="text-xs font-medium text-foreground">No installable ONNX models found</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
              Only repositories that ship both an ONNX graph and a tokenizer are listed, so every
              model can actually be used. Try a different search term.
            </p>
          </div>
        )}
      </div>
    );
  }

  function renderInspectView() {
    if (inspectError) {
      return (
        <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
          <p className="text-xs text-destructive font-medium">{inspectError}</p>
          <Button variant="outline" size="sm" onClick={() => setView("search")}>
            <ArrowLeft className="size-3.5 mr-1.5" />
            Back to search
          </Button>
        </div>
      );
    }

    if (!plan) {
      return (
        <div className="flex flex-col items-center justify-center py-8 text-center space-y-2">
          <CircleNotch className="size-6 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Analyzing repository layout and ONNX files…</p>
        </div>
      );
    }

    const poolingLabel = plan.poolingSourceRepo
      ? `mean (${plan.poolingSourceRepo})`
      : "mean";

    return (
      <div className="space-y-4 min-w-0">
        <div className="rounded-lg border border-border bg-muted/30 p-3.5 space-y-2 text-xs overflow-hidden">
          <div className="flex items-center justify-between gap-3 min-w-0">
            <span className="font-medium text-muted-foreground shrink-0">Repository:</span>
            <code
              className="font-mono font-semibold text-foreground truncate max-w-[65%] text-right"
              title={plan.repo}
            >
              {plan.repo}
            </code>
          </div>
          <div className="flex items-center justify-between gap-3 min-w-0">
            <span className="font-medium text-muted-foreground shrink-0">Variant:</span>
            <code
              className="font-mono text-foreground truncate max-w-[65%] text-right"
              title={plan.chosenVariant}
            >
              {plan.chosenVariant}
            </code>
          </div>
          {kind === "embedding" && (
            <div className="flex items-center justify-between gap-3 min-w-0">
              <span className="font-medium text-muted-foreground shrink-0">Pooling:</span>
              <span
                className="text-foreground truncate max-w-[65%] text-right"
                title={poolingLabel}
              >
                {poolingLabel}
              </span>
            </div>
          )}
          {kind === "reranker" && (
            <div className="flex items-center justify-between gap-3 min-w-0">
              <span className="font-medium text-muted-foreground shrink-0">Task:</span>
              <span className="text-foreground text-right truncate max-w-[65%]">
                Cross-encoder sequence classification
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-2 min-w-0">
            <span className="font-medium text-foreground shrink-0">Total Download Size:</span>
            <span className="font-mono font-semibold text-foreground shrink-0">
              {formatBytes(plan.totalBytes)}
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <span className="text-xs font-medium text-foreground">Files ({plan.files.length}):</span>
          <ul className="mt-1.5 space-y-1.5 max-h-44 overflow-y-auto overflow-x-hidden pr-1 min-w-0">
            {plan.files.map(renderFileRow)}
          </ul>
        </div>

        <DialogFooter className="flex-row justify-between sm:justify-between items-center gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setView("search")}
            disabled={installing}
          >
            <ArrowLeft className="size-3.5 mr-1.5" />
            Back to search
          </Button>
          <Button size="sm" onClick={() => void handleInstall()} disabled={installing}>
            {installing ? (
              <>
                <CircleNotch className="size-3.5 animate-spin mr-1.5" />
                Starting…
              </>
            ) : (
              <>
                <DownloadSimple className="size-3.5 mr-1.5" />
                Install Model
              </>
            )}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  function renderInstallingView() {
    const pct =
      jobStatus && jobStatus.estimatedBytes > 0
        ? Math.min(100, Math.round((jobStatus.bytesDownloaded / jobStatus.estimatedBytes) * 100))
        : 0;

    return (
      <div className="space-y-4 py-2 min-w-0">
        <div className="rounded-lg border border-border p-3.5 space-y-2.5 min-w-0 overflow-hidden">
          <div className="flex items-center justify-between gap-2.5 text-xs min-w-0">
            <span
              className="font-mono font-medium truncate flex-1 min-w-0 text-foreground"
              title={jobStatus?.currentFile}
            >
              {jobStatus?.currentFile ?? "Preparing download…"}
            </span>
            <Badge
              className="shrink-0 text-[10px]"
              variant={
                jobStatus?.status === "failed" || jobStatus?.status === "aborted"
                  ? "destructive"
                  : "secondary"
              }
            >
              {jobStatus?.status ?? "pending"}
            </Badge>
          </div>
          <Progress value={pct} className="h-2 rounded-full overflow-hidden" />
          <div className="flex justify-between items-center text-[11px] text-muted-foreground font-mono">
            <span>{formatBytes(jobStatus?.bytesDownloaded ?? 0)} downloaded</span>
            <span>{formatBytes(jobStatus?.estimatedBytes ?? 0)} total ({pct}%)</span>
          </div>
        </div>

        {jobStatus?.error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive break-words">
            {jobStatus.error}
          </div>
        )}

        {jobStatus?.status !== "completed" &&
          jobStatus?.status !== "failed" &&
          jobStatus?.status !== "aborted" && (
            <div className="flex justify-end pt-1">
              <Button variant="outline" size="sm" onClick={() => void cancelInstall()}>
                <Pause className="size-3.5 mr-1.5" /> Cancel Download
              </Button>
            </div>
          )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <DownloadSimple className="size-4 mr-1.5" />
          Add Model
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto overflow-x-hidden min-w-0 p-5 sm:p-6">
        <DialogHeader className="pr-6">
          <DialogTitle>Browse {kind} models</DialogTitle>
          <DialogDescription>
            Top ONNX models from HuggingFace, ranked by downloads. Only repositories with a
            tokenizer are shown, so every model installs ready to use.
          </DialogDescription>
        </DialogHeader>
        <div className="pt-2 min-w-0 overflow-hidden">
          {view === "search" && renderSearchView()}
          {view === "inspect" && renderInspectView()}
          {view === "installing" && renderInstallingView()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
