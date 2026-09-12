"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  CircleNotch,
  DownloadSimple,
  GithubLogo,
  MagicWand,
  Storefront,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isInstalled,
  type MarketplaceItem,
  type RegistryTab,
  type SkillRow,
} from "@/components/skills/types";

/**
 * "Skill marketplace" tab — browse and install third-party skills
 * from ClawHub (browse-first, sorted catalog with cursor pagination),
 * skills.sh and any GitHub repo (query-driven). State and effects are
 * keyed to the active registry; every request resets the previous
 * registry's results.
 */

const REGISTRIES: Array<{ value: RegistryTab; label: string }> = [
  { value: "clawhub", label: "ClawHub" },
  { value: "skillssh", label: "skills.sh" },
  { value: "github", label: "GitHub repo" },
];

const CLAWHUB_SORTS: Array<{ value: string; label: string }> = [
  { value: "recommended", label: "Recommended" },
  { value: "downloads", label: "Most installed" },
  { value: "stars", label: "Most starred" },
  { value: "trending", label: "Trending" },
  { value: "updated", label: "Recently updated" },
  { value: "createdAt", label: "Newest" },
  { value: "name", label: "Name (A-Z)" },
];

type Props = {
  skills: SkillRow[];
  busyKey: string | null;
  onInstall: (key: string, payload: Record<string, unknown>) => void;
};

export function SkillMarketplaceTab({
  skills,
  busyKey,
  onInstall,
}: Props) {
  const [tab, setTab] = useState<RegistryTab>("clawhub");
  const [query, setQuery] = useState("");
  const [githubRepo, setGithubRepo] = useState("");

  // ClawHub browse state (catalog + cursor pagination).
  const [sort, setSort] = useState("recommended");
  const [browse, setBrowse] = useState<MarketplaceItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [loadingFirstPage, setLoadingFirstPage] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Query-driven results (ClawHub search, skills.sh, GitHub listing).
  const [results, setResults] = useState<MarketplaceItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Keep the latest sort for the load-more callback without re-running
  // the mount effect (same ref pattern the PluginsView uses).
  const sortRef = useRef(sort);
  useEffect(() => {
    sortRef.current = sort;
  }, [sort]);

  /** Fetch one page of the ClawHub catalog; append when cursor is given. */
  const loadBrowse = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams({ registry: "clawhub", browse: "1" });
      params.set("sort", sortRef.current);
      if (cursor) params.set("cursor", cursor);
      if (cursor) setLoadingMore(true);
      else setLoadingFirstPage(true);
      setBrowseError(null);
      try {
        const res = await fetch(`/api/skills/search?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load catalog.");
        const page = (data.items ?? []).map(
          (raw: Record<string, unknown>, index: number) =>
            toItem("clawhub", raw, index, cursor)
        );
        setBrowse((prev) => (cursor ? [...prev, ...page] : page));
        setNextCursor(data.nextCursor ?? null);
      } catch (err) {
        setBrowseError(err instanceof Error ? err.message : "Failed to load catalog.");
      } finally {
        setLoadingFirstPage(false);
        setLoadingMore(false);
      }
    },
    []
  );

  // ClawHub is browse-first: fetch the recommended catalog once on
  // mount. Later fetches (sort change, registry switch, load-more)
  // all go through their own handlers.
  const browseLoadedRef = useRef(false);
  useEffect(() => {
    if (tab !== "clawhub" || browseLoadedRef.current) return;
    browseLoadedRef.current = true;
    void loadBrowse();
  }, [tab, loadBrowse]);  /** Switch registry: reset all query/browse state for a clean slate. */
  const switchRegistry = useCallback(
    (next: RegistryTab) => {
      setTab(next);
      setQuery("");
      setResults(null);
      setSearchError(null);
      setSearching(false);
      setBrowseError(null);
      if (next === "clawhub") {
        // ClawHub is browse-first: reset the catalog to its default sort
        // and load the first page (also resets the mount-once guard so
        // switching back always shows fresh state).
        setSort("recommended");
        sortRef.current = "recommended";
        setBrowse([]);
        setNextCursor(null);
        setLoadingFirstPage(true);
        browseLoadedRef.current = false;
        void loadBrowse();
      }
    },
    [loadBrowse]
  );

  /** Re-fetch the first catalog page for the current sort. */
  const reloadForSort = useCallback(
    (next: string) => {
      setSort(next);
      sortRef.current = next;
      setBrowse([]);
      setNextCursor(null);
      setLoadingFirstPage(true);
      void loadBrowse();
    },
    [loadBrowse]
  );

  const runSearch = useCallback(async () => {
    setSearchError(null);
    if (tab === "github") {
      const repo = githubRepo.trim();
      if (!repo) return;
      setSearching(true);
      setResults(null);
      try {
        const res = await fetch(
          `/api/skills/search?registry=github&repo=${encodeURIComponent(repo)}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to list repo skills.");
        setResults(
          (data.skills ?? []).map(
            (entry: { name: string; dirPath: string }, index: number) =>
              toItem("github", entry, index, undefined, repo)
          )
        );
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
    setResults(null);
    try {
      const res = await fetch(
        `/api/skills/search?registry=${tab}&q=${encodeURIComponent(q)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      setResults(
        (data.results ?? []).map(
          (raw: Record<string, unknown>, index: number) =>
            toItem(tab, raw, index, undefined)
        )
      );
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, [githubRepo, query, tab]);

  /** Leave ClawHub search mode → back to the browsed catalog. */
  const clearSearch = useCallback(() => {
    setQuery("");
    setResults(null);
    setSearchError(null);
  }, []);

  const searchDisabled =
    tab === "github" ? !githubRepo.trim() || searching : query.trim().length < 2 || searching;

  const resultCount = results?.length ?? browse.length;

  const resultLabel = useMemo(() => {
    if (tab !== "clawhub") return null;
    if (results) return `${results.length} result${results.length === 1 ? "" : "s"} for “${query.trim()}”`;
    return browse.length > 0 ? `${browse.length} skills` : null;
  }, [browse.length, query, results, tab]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-lg">
          <Storefront className="size-5" />
          Skill marketplace
        </h2>
        <p className="mt-0.5 text-muted-foreground text-xs">
          Third-party skills are instructions written by their authors —
          review the SKILL.md after installing. Suspicious ClawHub skills
          are hidden automatically.
        </p>
      </div>

      {/* Registry picker */}
      <div className="flex flex-wrap gap-2">
        {REGISTRIES.map(({ value, label }) => (
          <Button
            key={value}
            onClick={() => switchRegistry(value)}
            size="sm"
            type="button"
            variant={tab === value ? "default" : "outline"}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* Search / repo row */}
      <div className="flex flex-col gap-2 sm:flex-row">
        {tab === "github" ? (
          <div className="flex flex-1 gap-2">
            <Input
              aria-label="GitHub repository"
              onChange={(e) => setGithubRepo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder="owner/repo or github.com URL (e.g. anthropics/skills)"
              value={githubRepo}
            />
            <Button
              disabled={searchDisabled}
              onClick={() => void runSearch()}
              type="button"
            >
              {searching ? (
                <CircleNotch className="size-4 animate-spin" />
              ) : (
                <GithubLogo className="size-4" />
              )}
              List skills
            </Button>
          </div>
        ) : (
          <div className="flex flex-1 gap-2">
            <Input
              aria-label={
                tab === "clawhub" ? "Search ClawHub skills" : "Search skills.sh skills"
              }
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder={
                tab === "clawhub" ? "Search ClawHub skills…" : "Search skills.sh…"
              }
              value={query}
            />
            <Button
              disabled={searchDisabled}
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
        )}
        {tab === "clawhub" && !results && (
          <Select onValueChange={reloadForSort} value={sort}>
            <SelectTrigger aria-label="Sort catalog" className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLAWHUB_SORTS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {searchError && (
        <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          <Warning className="size-4 shrink-0" />
          {searchError}
        </p>
      )}

      {/* ClawHub browse-mode error / loading states */}
      {tab === "clawhub" && !results && browseError && (
        <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          <Warning className="size-4 shrink-0" />
          {browseError}
        </p>
      )}
      {tab === "clawhub" && !results && loadingFirstPage && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              className="flex items-center gap-3 rounded-md border px-3 py-3"
              key={i}
            >
              <CircleNotch className="size-4 animate-spin text-muted-foreground" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-1/3 rounded-sm bg-muted" />
                <div className="h-2.5 w-2/3 rounded-sm bg-muted/70" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Result list header */}
      {(results !== null || (tab === "clawhub" && browse.length > 0)) && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            {resultLabel ?? `${resultCount} skill${resultCount === 1 ? "" : "s"}`}
          </p>
          {results && tab === "clawhub" && (
            <Button
              onClick={clearSearch}
              size="xs"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
              Clear search
            </Button>
          )}
        </div>
      )}

      {/* Results */}
      {results !== null && results.length === 0 && !searchError && (
        <p className="text-muted-foreground text-sm">
          {tab === "github"
            ? "No SKILL.md folders found in that repository."
            : `No skills matched “${query.trim()}”.`}
        </p>
      )}

      {results !== null && results.length > 0 && (
        <ul className="space-y-2">
          {results.map((item) => (
            <MarketplaceRow
              busyKey={busyKey}
              installed={skills.some((s) => isInstalled(s, item))}
              item={item}
              key={item.key}
              onInstall={onInstall}
            />
          ))}
        </ul>
      )}

      {tab === "clawhub" && !results && !loadingFirstPage && browse.length === 0 && !browseError && (
        <p className="text-muted-foreground text-sm">
          No skills in the catalog. Try a different sort or search instead.
        </p>
      )}

      {tab === "clawhub" && !results && browse.length > 0 && (
        <ul className="space-y-2">
          {browse.map((item) => (
            <MarketplaceRow
              busyKey={busyKey}
              installed={skills.some((s) => isInstalled(s, item))}
              item={item}
              key={item.key}
              onInstall={onInstall}
            />
          ))}
        </ul>
      )}

      {tab === "clawhub" && !results && nextCursor && (
        <div className="flex justify-center pt-1">
          <Button
            disabled={loadingMore || busyKey !== null}
            onClick={() => void loadBrowse(nextCursor)}
            size="sm"
            type="button"
            variant="outline"
          >
            {loadingMore ? (
              <CircleNotch className="size-4 animate-spin" />
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      )}

      {/* skill-creator hint */}
      <Separator className="my-2" />
      <div className="flex items-start gap-2">
        <MagicWand className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground text-xs">
          Skill creator: install Anthropic&apos;s official{" "}
          <button
            className="underline underline-offset-2 hover:text-foreground"
            disabled={busyKey !== null}
            onClick={() =>
              onInstall("builtin:skill-creator", {
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
    </div>
  );
}

/* ── One result row ─────────────────────────────────────────────── */

function MarketplaceRow({
  item,
  installed,
  busyKey,
  onInstall,
}: {
  item: MarketplaceItem;
  installed: boolean;
  busyKey: string | null;
  onInstall: (key: string, payload: Record<string, unknown>) => void;
}) {
  const busy = busyKey === item.key;
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 font-medium text-sm">
          {item.title}
          {item.byline && (
            <span className="text-muted-foreground text-xs">{item.byline}</span>
          )}
        </p>
        {item.summary && (
          <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
            {item.summary}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {typeof item.installs === "number" && (
          <span className="hidden text-muted-foreground text-xs sm:inline">
            {item.installs.toLocaleString()} installs
          </span>
        )}
        {installed && <Badge variant="default">Installed</Badge>}
        <Button
          disabled={busyKey !== null}
          onClick={() => onInstall(item.key, item.installPayload)}
          size="sm"
          type="button"
          variant={installed ? "ghost" : "outline"}
        >
          {busy ? (
            <CircleNotch className="size-4 animate-spin" />
          ) : (
            <DownloadSimple className="size-4" />
          )}
          {installed ? "Reinstall" : "Install"}
        </Button>
      </div>
    </li>
  );
}

/* ── Normalization helper ───────────────────────────────────────── */

/**
 * Map one raw registry row to the marketplace item shape. `index`
 * keeps keys stable per page; `cursor` separates pages during
 * cursor-append so appended rows never collide with the first page.
 */
function toItem(
  registry: RegistryTab,
  raw: Record<string, unknown>,
  index: number,
  cursor?: string,
  githubRepo?: string
): MarketplaceItem {
  if (registry === "clawhub") {
    const slug = String(raw.slug ?? "");
    const owner = raw.ownerHandle ? String(raw.ownerHandle) : undefined;
    return {
      key: `clawhub:${owner ? `${owner}/` : ""}${slug}:${cursor ?? ""}:${index}`,
      title: String(raw.displayName ?? slug),
      byline: owner ? `@${owner}` : undefined,
      summary: raw.summary ? String(raw.summary) : undefined,
      installs: typeof raw.downloads === "number" ? raw.downloads : undefined,
      installPayload: {
        registry: "clawhub",
        ref: `${owner ? `@${owner}/` : ""}${slug}`,
      },
    };
  }
  if (registry === "skillssh") {
    const id = String(raw.id ?? "");
    const skillId = String(raw.skillId ?? "");
    const source = String(raw.source ?? "");
    return {
      key: `skillssh:${id}:${index}`,
      title: String(raw.name ?? skillId),
      byline: source,
      summary: "Resolves and installs from its GitHub source repository.",
      installs: typeof raw.installs === "number" ? raw.installs : undefined,
      installPayload: {
        registry: "skillssh",
        id,
        source,
        skillId,
      },
    };
  }
  const name = String(raw.name ?? "");
  const dirPath = String(raw.dirPath ?? "");
  return {
    key: `github:${githubRepo ?? ""}:${dirPath}:${index}`,
    title: name,
    byline: githubRepo || undefined,
    summary: dirPath ? dirPath : "Repo root SKILL.md",
    installPayload: {
      registry: "github",
      repo: githubRepo || undefined,
      path: dirPath || undefined,
    },
  };
}
