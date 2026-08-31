"use client";

import { PageView } from "@/components/app-shell/page-view";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEffect, useState } from "react";
import { KnowledgeGraphTab } from "@/components/statistics/knowledge-graph-tab";
import { OverviewTab } from "@/components/statistics/overview-tab";
import { SystemLogsTab } from "@/components/statistics/system-logs-tab";
import type { SystemStats } from "@/components/statistics/types";

/**
 * Statistics page — three separated areas behind one shell:
 *   • Overview          — live system dashboard (device, resources,
 *                          services, cognitive memory) + hero stat tiles
 *   • Knowledge graph   — force-directed memory graph (lazy: fetched
 *                          and laid out only while this tab is active)
 *   • System logs       — live structured log viewer with filters
 *
 * The overview data comes from one 5s poll owned here; the graph and
 * logs tabs own their own fetching so their work only happens while
 * mounted. Same in-shell layout contract and tab pattern as
 * SkillsView / PluginsView.
 */

const STATS_TABS = [
  { value: "overview", label: "Overview" },
  { value: "graph", label: "Knowledge graph" },
  { value: "logs", label: "System logs" },
] as const;

type StatsTab = (typeof STATS_TABS)[number]["value"];

export function StatisticsView({ onBack }: { onBack: () => void }) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [activeTab, setActiveTab] = useState<StatsTab>("overview");

  // Live stats: poll every 5s with AbortController and monotonic
  // timestamp check (a stale sample never overwrites a newer one).
  useEffect(() => {
    let cancelled = false;
    let latestTimestamp = 0;
    const controller = new AbortController();

    const load = async () => {
      try {
        const res = await fetch("/api/system/stats", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as SystemStats;
        const ts = new Date(data.collectedAt).getTime();
        if (!cancelled && ts >= latestTimestamp) {
          latestTimestamp = ts;
          setStats(data);
        }
      } catch {
        // Transient polling failures are silent.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <PageView
      actions={
        stats ? (
          <p
            className="flex items-center gap-1.5 text-muted-foreground text-xs"
            title={`Latest sample: ${new Date(stats.collectedAt).toLocaleString()}`}
          >
            <span className="relative flex size-2 motion-safe:animate-ping">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Live · {new Date(stats.collectedAt).toLocaleTimeString()}
          </p>
        ) : undefined
      }
      onBack={onBack}
      title="Statistics"
    >
      <p className="mb-4 mt-1 text-muted-foreground text-sm">
        Live system vitals, the knowledge graph of consolidated memories,
        and structured logs from the cognitive loop.
      </p>

      <Tabs
        className="gap-4"
        onValueChange={(value) => setActiveTab(value as StatsTab)}
        value={activeTab}
      >
        <TabsList>
          {STATS_TABS.map((tab) => (
            <TabsTrigger className="px-3" key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Radix keeps inactive content mounted by default; rendering
            per-tab means the graph layout and log polling only run
            while their tab is actually visible. */}
        {activeTab === "overview" && (
          <TabsContent value="overview">
            <OverviewTab stats={stats} />
          </TabsContent>
        )}
        {activeTab === "graph" && (
          <TabsContent value="graph">
            <KnowledgeGraphTab />
          </TabsContent>
        )}
        {activeTab === "logs" && (
          <TabsContent value="logs">
            <SystemLogsTab />
          </TabsContent>
        )}
      </Tabs>
    </PageView>
  );
}
