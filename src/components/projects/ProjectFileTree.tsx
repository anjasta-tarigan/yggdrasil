"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import {
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileText,
  FileImage,
  CaretRight,
  CaretDown,
  ArrowsClockwise,
  MagnifyingGlass,
  X,
  WarningCircle,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export interface ProjectFileEntry {
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface ProjectFileTreeProps {
  projectId: string;
  onClose?: () => void;
  className?: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  children: TreeNode[];
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "json":
    case "html":
    case "css":
    case "py":
    case "go":
    case "rs":
    case "sh":
    case "sql":
      return <FileCode className="size-4 shrink-0 text-blue-500/80" />;
    case "md":
    case "txt":
    case "log":
      return <FileText className="size-4 shrink-0 text-muted-foreground" />;
    case "png":
    case "jpg":
    case "jpeg":
    case "svg":
    case "webp":
    case "gif":
      return <FileImage className="size-4 shrink-0 text-emerald-500/80" />;
    default:
      return <File className="size-4 shrink-0 text-muted-foreground" />;
  }
}

function buildTree(entries: ProjectFileEntry[]): TreeNode[] {
  const rootNodes: TreeNode[] = [];
  const map = new Map<string, TreeNode>();

  for (const entry of entries) {
    const parts = entry.path.split("/");
    const name = parts[parts.length - 1];
    const node: TreeNode = {
      name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      size: entry.size,
      children: [],
    };
    map.set(entry.path, node);

    if (parts.length === 1) {
      rootNodes.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = map.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }
  }

  // Sort: directories first, then alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children.length > 0) {
        sortNodes(n.children);
      }
    }
  };

  sortNodes(rootNodes);
  return rootNodes;
}

export function ProjectFileTree({
  projectId,
  onClose,
  className,
}: ProjectFileTreeProps) {
  const [files, setFiles] = useState<ProjectFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/files`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to load project files");
      }
      const data = await res.json();
      const entries: ProjectFileEntry[] = Array.isArray(data) ? data : [];
      setFiles(entries);

      // Auto-expand all top-level directories
      const initialExpanded = new Set<string>();
      for (const entry of entries) {
        if (entry.isDirectory) {
          initialExpanded.add(entry.path);
        }
      }
      setExpandedPaths(initialExpanded);
    } catch (err: unknown) {
      const errorObj = err as Error;
      setError(errorObj.message || "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchFiles is stable callback from useCallback
    void fetchFiles();
  }, [fetchFiles]);

  const toggleExpand = (dirPath: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const filteredEntries = useMemo(() => {
    if (!search.trim()) return files;
    const query = search.toLowerCase().trim();
    return files.filter((f) => f.path.toLowerCase().includes(query));
  }, [files, search]);

  const tree = useMemo(() => {
    return buildTree(filteredEntries);
  }, [filteredEntries]);

  const renderNode = (node: TreeNode, depth = 0) => {
    const isExpanded = expandedPaths.has(node.path);

    return (
      <div key={node.path} className="select-none">
        <div
          className={cn(
            "group flex items-center justify-between gap-1.5 rounded px-2 py-1 text-xs hover:bg-muted/70 cursor-pointer transition-colors",
            depth > 0 && "ml-3"
          )}
          onClick={() => {
            if (node.isDirectory) {
              toggleExpand(node.path);
            }
          }}
          title={node.path}
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {node.isDirectory ? (
              <>
                {isExpanded ? (
                  <CaretDown className="size-3 text-muted-foreground shrink-0" />
                ) : (
                  <CaretRight className="size-3 text-muted-foreground shrink-0" />
                )}
                {isExpanded ? (
                  <FolderOpen className="size-4 text-amber-500/80 shrink-0" />
                ) : (
                  <Folder className="size-4 text-amber-500/80 shrink-0" />
                )}
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                {getFileIcon(node.name)}
              </>
            )}
            <span className="truncate text-foreground font-medium">
              {node.name}
            </span>
          </div>

          {!node.isDirectory && (
            <span className="text-[10px] text-muted-foreground font-mono shrink-0">
              {formatFileSize(node.size)}
            </span>
          )}
        </div>

        {node.isDirectory && isExpanded && node.children.length > 0 && (
          <div className="border-l border-border/40 ml-3.5 pl-0.5">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={cn(
        "flex flex-col h-full bg-background border-l border-border w-72 shrink-0 select-none overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border bg-muted/20">
        <div className="flex items-center gap-2">
          <Folder className="size-4 text-primary" />
          <span className="font-semibold text-xs text-foreground tracking-tight">
            Files
          </span>
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full font-mono">
            {files.filter((f) => !f.isDirectory).length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={fetchFiles}
            disabled={loading}
            aria-label="Refresh files"
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowsClockwise
              className={cn("size-3.5", loading && "animate-spin")}
            />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label="Close file explorer"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Filter search */}
      <div className="p-2 border-b border-border/50">
        <div className="relative">
          <MagnifyingGlass className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files..."
            className="h-7 text-xs pl-8 pr-2 bg-muted/40"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-muted-foreground">
            <Spinner className="size-4" />
            <span className="text-xs">Loading files...</span>
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-destructive flex flex-col gap-2 items-center text-center">
            <WarningCircle className="size-5" />
            <span>{error}</span>
            <Button
              variant="outline"
              size="xs"
              onClick={fetchFiles}
              className="mt-1"
            >
              Retry
            </Button>
          </div>
        ) : tree.length === 0 ? (
          <div className="text-center py-8 text-xs text-muted-foreground">
            {search ? "No matching files" : "No files found in workspace"}
          </div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>
    </div>
  );
}
