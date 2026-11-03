"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ModelKind } from "@/lib/models/types";
import {
  AboutTab,
  DatabaseTab,
  EmbeddingTab,
  GeneralTab,
  ProviderTab,
  RerankerTab,
  type EmbeddingSource,
} from "@/components/settings/tabs";
import { ToolsTab } from "@/components/settings/tools-tab";
import { PersonaTab } from "@/components/settings/persona-tab";
import { ModelForm } from "@/components/settings/model-form";
import { NimProviderDialog } from "@/components/settings/nim-provider-dialog";
import { ProviderEditDialog } from "@/components/settings/provider-edit-dialog";
import { useEmbeddingSettings } from "@/components/settings/hooks/use-embedding-settings";
import { useRerankerSettings } from "@/components/settings/hooks/use-reranker-settings";
import { useProviderRegistry } from "@/components/settings/hooks/use-provider-registry";
import { useDatabaseMaintenance } from "@/components/settings/hooks/use-database-maintenance";
import { usePersonaSettings } from "@/components/settings/hooks/use-persona-settings";
import { useToolsSettings } from "@/components/settings/hooks/use-tools-settings";
import { GgufAddDialog } from "@/components/settings/gguf-add-dialog";
import { EmbeddingChangeDialog } from "@/components/settings/embedding-change-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_INTROS,
  type SettingsTab,
} from "@/components/settings/shared";
import {
  type WebSearchProviderKind,
} from "@/lib/settings";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  getMobileSettingsSnapshot,
  loadSettingsSnapshot,
  subscribeToMobileSettings,
  webSearchFormFromEntries,
  type SettingsSnapshot,
} from "@/components/settings/snapshot";
import { useEffect, useMemo, useCallback, useRef, useState, useSyncExternalStore } from "react";

/**
 * Settings rendered inside the app shell's content area (the sidebar,
 * header and status footer stay in place). Selecting any chat in the
 * sidebar — or the back button — returns to the conversation.
 *
 * Same layout contract as Skills / Plugins / Statistics: one horizontal
 * tab bar with a scrollable list, a short intro paragraph, and content
 * cards in a single centered column.
 */
export function SettingsView({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Bumped after saving so the snapshot (status badges, effective chain)
  // is re-fetched from the server.
  const [settingsVersion, setSettingsVersion] = useState(0);

  // Database-tab maintenance state. Declared before the embedding hook because
  // an index rebuild reports its outcome in the same maintenance banner.
  const {
    maintenanceBusy,
    maintenanceNote,
    setMaintenanceNote,
    runMaintenancePass,
    runEmbeddingBackfillNow,
    dbBusy,
    dbNote,
    dbNoteKind,
    optimizeDatabase,
    resetDatabaseNow,
    diagnostics,
    diagnosticsBusy,
    refreshDiagnostics,
  } = useDatabaseMaintenance({
    onRefresh: () => setSettingsVersion((v) => v + 1),
  });

  // Provider-registry state, add/edit flows, and model CRUD. Radix unmounts
  // inactive tab panels, so this state must stay in the shell.
  const {
    providers,
    ollamaBusy,
    ollamaError,
    openaiFormOpen,
    setOpenaiFormOpen,
    oaName,
    setOaName,
    oaBaseUrl,
    setOaBaseUrl,
    oaApiKey,
    setOaApiKey,
    oaBusy,
    oaError,
    setOaError,
    nimForm,
    setNimForm,
    ggufDialogOpen,
    setGgufDialogOpen,
    ggufBusy,
    ggufError,
    ggufServerFound,
    ggufServerPath,
    ggufServerVersion,
    ggufModels,
    ggufCustomServerPath,
    setGgufCustomServerPath,
    ggufSelectedModels,
    setGgufSelectedModels,
    editingProvider,
    setEditingProvider,
    editProviderDialogOpen,
    setEditProviderDialogOpen,
    editProvName,
    setEditProvName,
    editProvBaseUrl,
    setEditProvBaseUrl,
    editProvApiKey,
    setEditProvApiKey,
    editProvClearKey,
    setEditProvClearKey,
    editProvError,
    editProvBusy,
    modelFormOpen,
    setModelFormOpen,
    modelFormTargetProviderId,
    editingModel,
    setEditingModel,
    addOllama,
    addGguf,
    reprobeGgufServer,
    ggufDialogConfirm,
    addOpenaiProvider,
    deleteProvider,
    editProvider,
    saveNimProvider,
    handleSaveEditedProvider,
    refreshProviders,
    addModel,
    editModel,
    deleteModel,
    handleSaveModel,
  } = useProviderRegistry({ snapshot: settings });

  // Embedding-tab state, probe/save handlers, and the model-change dialog.
  // Radix unmounts inactive tab panels, so this state must stay in the shell.
  const {
    embSource,
    setEmbSource,
    embBaseUrl,
    setEmbBaseUrl,
    embLegacyProviderName,
    embApiKey,
    setEmbApiKey,
    embModel,
    setEmbModel,
    embDimensions,
    setEmbDimensions,
    embApiKeyConfigured,
    clearEmbApiKey,
    embClearKey,
    setEmbClearKey,
    embeddingSaved,
    embSaveError,
    embCanForceSave,
    detectBusy,
    detectResult,
    setDetectResult,
    embOnnxModelPath,
    setEmbOnnxModelPath,
    modelChanged,
    rebuildBusy,
    rebuildProgress,
    rebuildError,
    handleRebuildEmbeddings,
    dismissModelChange,
    saveEmbedding,
    detectDimensions,
  } = useEmbeddingSettings({
    snapshot: settings,
    onRefresh: () => setSettingsVersion((v) => v + 1),
    onMaintenanceNote: setMaintenanceNote,
  });

  // Tools-tab state: web search providers and per-tool toggles
  const {
    wsForm,
    wsSaved,
    wsSaveError,
    updateWsForm,
    saveWebSearch,
    toolsSaved,
    toolsSaveError,
    toggleTool,
  } = useToolsSettings({
    snapshot: settings,
    onRefresh: () => setSettingsVersion((v) => v + 1),
    setSnapshot: setSettings,
  });

  // Reranker-tab state and auto-save handlers. Radix unmounts inactive tab
  // panels, so this state must stay in the shell.
  const {
    rerankerEnabled,
    rerankerSelectedModel,
    rerankerProvider,
    rerankerBaseUrl,
    rerankerRemoteModel,
    rerankerApiKeyEnv,
    rerankerIdleTimeoutMinutes,
    rerankerSaved,
    rerankerSaveError,
    rerankerProbeBusy,
    rerankerProbeResult,
    rerankerSaving,
    handleToggleReranker,
    handleSelectRerankerModel,
    handleChangeRerankerIdleTimeout,
    handleRerankerModelDeleted,
    handleSaveReranker,
    handleRerankerProviderChange,
    runRerankerProbe,
    handleRerankerBaseUrlChange,
    handleRerankerRemoteModelChange,
    handleRerankerApiKeyEnvChange,
  } = useRerankerSettings({
    snapshot: settings,
    onRefresh: () => setSettingsVersion((v) => v + 1),
    setSnapshot: setSettings,
  });

  // Active settings tab — single source of truth for the switcher.
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  // ---- Model download/install notification ----
  const [installedModelNotification, setInstalledModelNotification] = useState<{
    repo: string;
    kind: ModelKind;
  } | null>(null);
  const notifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (notifTimerRef.current) {
        clearTimeout(notifTimerRef.current);
      }
    };
  }, []);

  // ── Responsive layout: vertical nav on desktop, horizontal on mobile ──
  const isMobile = useSyncExternalStore(
    subscribeToMobileSettings,
    getMobileSettingsSnapshot,
    () => false,
  );

  // ── Close-guard: dirty tracking + rebuild blocking ──
  // System persona tab state, save/reset handlers, and dirty tracking
  const {
    persona,
    defaultPersona,
    personaDirty,
    setPersonaDirty,
    handleSavePersona,
    handleResetPersona,
  } = usePersonaSettings({
    open,
    settingsVersion,
  });

  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  const isDirty = useMemo(() => {
    if (!settings) return false;

    // Add-provider form is dirty when any field has content.
    if (openaiFormOpen && (oaName.trim() || oaBaseUrl.trim() || oaApiKey.trim())) {
      return true;
    }

    // Embedding form changes against the server snapshot.
    const emb = settings.embedding;
    if (emb) {
      if (embApiKey.trim() || embClearKey) return true;
      const storedSource: EmbeddingSource =
        !emb.providerId && emb.provider === "onnx" ? "onnx" : "remote";
      if (embSource !== storedSource) return true;
      if (embSource === "onnx") {
        if (embOnnxModelPath !== (emb.modelPath ?? "")) return true;
        if (embDimensions !== (emb.dimensions ?? null)) return true;
      } else {
        // A legacy providerId block is displayed as its endpoint; use that
        // endpoint as the baseline so prefill alone does not look dirty.
        const baselineBaseUrl =
          emb.baseUrl ??
          (emb.providerId
            ? providers.find((p) => p.id === emb.providerId)?.baseUrl ?? ""
            : "");
        if (embBaseUrl !== baselineBaseUrl) return true;
        if (embModel !== (emb.model ?? "")) return true;
        if (embDimensions !== (emb.dimensions ?? null)) return true;
      }
    }

    // Web search form changes against the server snapshot.
    const wsSnapshot = webSearchFormFromEntries(
      settings.store?.websearch?.providers?.length
        ? settings.store.websearch.providers
        : settings.webSearch?.providers ?? []
    );
    for (const kind of Object.keys(wsForm) as WebSearchProviderKind[]) {
      if (wsForm[kind].enabled !== wsSnapshot[kind].enabled) return true;
      if (wsForm[kind].apiKey !== wsSnapshot[kind].apiKey) return true;
      if (JSON.stringify(wsForm[kind].removeApiKeyIds) !== JSON.stringify(wsSnapshot[kind].removeApiKeyIds)) return true;
      if (wsForm[kind].apiKeys.length !== wsSnapshot[kind].apiKeys.length) return true;
      if (wsForm[kind].baseUrl !== wsSnapshot[kind].baseUrl) return true;
    }

    return false;
  }, [
    settings,
    openaiFormOpen,
    oaName,
    oaBaseUrl,
    oaApiKey,
    embApiKey,
    embClearKey,
    embSource,
    embOnnxModelPath,
    embBaseUrl,
    embModel,
    embDimensions,
    providers,
    wsForm,
  ]);

  // Single chokepoint for closing the dialog: blocks during SSE rebuild,
  // confirms when there are unsaved changes via PersonaTab, otherwise closes.
  const requestClose = useCallback(() => {
    if (rebuildBusy) return; // silently blocked; inner rebuild dialog handles UX
    if (isDirty || personaDirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  }, [rebuildBusy, isDirty, personaDirty, onOpenChange, setConfirmDiscardOpen]);

  const confirmAndClose = () => {
    setConfirmDiscardOpen(false);
    onOpenChange(false);
  };

  function handleModelInstalled(kind: ModelKind, repo?: string) {
    setSettingsVersion((v) => v + 1);
    if (repo) {
      setInstalledModelNotification({ repo, kind });
      if (kind === "embedding") {
        setEmbSource("onnx");
      }
      if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
      notifTimerRef.current = setTimeout(() => {
        setInstalledModelNotification((prev) => (prev?.repo === repo ? null : prev));
      }, 8000);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadSettingsSnapshot()
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [settingsVersion, open]);

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent
          className={cn(
            // Mobile: fullscreen, no rounding, no transform offset.
            // sm:max-w-none: tailwind-merge only dedupes same-modifier
            // classes, so the base DialogContent's `sm:max-w-md` would
            // survive the unprefixed max-w-* here and cap the dialog at
            // 448px on 640–767px viewports.
            "fixed inset-0 z-50 w-full max-w-none sm:max-w-none h-full translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0",
            // Desktop: centered, floating with constrained size
            "md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:max-w-4xl md:w-[calc(100%-2rem)] md:h-[min(720px,85dvh)] md:rounded-xl",
            "overflow-hidden max-w-full",
          )}
          showCloseButton
        >
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Application settings. Press Escape to close.
          </DialogDescription>

          <Tabs
            // Mobile: column (tabs nav above, content below)
            // Desktop: row (sidebar nav left, content right, both full height)
            // min-w-0: DialogContent is a grid; without it the grid item's
            // min-content contribution (wide <pre>/URL content) sizes the
            // auto track beyond the dialog width, making the pane render
            // wider than the dialog and clipping content mid-line.
            className="flex flex-col h-full w-full min-h-0 min-w-0 gap-0 md:flex-row"
            onValueChange={(value) => setActiveTab(value as SettingsTab)}
            orientation={isMobile ? "horizontal" : "vertical"}
            value={activeTab}
          >
            {/* Desktop: sidebar nav on left (fixed width, full height, scrollable). */}
            {!isMobile && (
              // justify-start overrides the base `justify-center`: in this
              // column list it would vertically center the menu block
              // instead of running it top-to-bottom.
              <TabsList className="flex-col justify-start h-full min-h-0 w-56 shrink-0 items-start gap-1 border-r bg-muted/40 p-3 overflow-y-auto [scrollbar-gutter:stable]">
                {SETTINGS_TABS.map((tab) => (
                  <TabsTrigger
                    // flex-none overrides the base `flex-1` (needed for equal
                    // widths in horizontal mode): in this column list it would
                    // stretch each item to ~70px, overriding h-9 via
                    // flex-basis:0% + grow:1 and spacing the menu out.
                    className="flex-none h-9 rounded-md justify-start gap-2 px-3 w-full"
                    key={tab.value}
                    value={tab.value}
                  >
                    <tab.icon className="size-4 shrink-0" />
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}

            {/* Mobile: horizontal nav at top.
                h-auto keeps the strip sized to its 36px triggers + p-3; the
                tabs base no longer forces a height (it used to pin h-8 and
                clip this strip). justify-start: base `justify-center` +
                overflow-x makes the first tabs unreachable (scrollLeft
                cannot go negative). */}
            {isMobile && (
              <TabsList className="flex-row h-auto w-full min-w-full items-center justify-start gap-1 p-3 border-b overflow-x-auto">
                {SETTINGS_TABS.map((tab) => (
                  <TabsTrigger
                    className="h-9 rounded-md px-3 shrink-0"
                    key={tab.value}
                    value={tab.value}
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}

            {/* Right pane: header + scrollable content */}
            <div className="flex flex-col flex-1 min-h-0 min-w-0">
              {/* Header (desktop only; sits above the scroll container, so no sticky needed) */}
              {!isMobile && (
                <div className="shrink-0 border-b bg-popover px-6 py-4">
                  <h2 className="text-lg font-semibold">
                    {SETTINGS_TABS.find((t) => t.value === activeTab)?.label}
                  </h2>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    {SETTINGS_TAB_INTROS[activeTab]}
                  </p>
                </div>
              )}

              {/* Scrollable content area.
                  overflow-x-hidden + w-full on the wrapper constrain wide <pre>
                  content so the tabpanel never stretches beyond the dialog. */}
              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
                <div className={cn("w-full min-w-0", isMobile ? "px-4 py-3" : "px-6 py-4")}>
                  {loadError && (
                    <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
                      Could not load server configuration.
                    </p>
                  )}

                  {isMobile && (
                    <p className="mb-3 text-muted-foreground text-xs">
                      {SETTINGS_TAB_INTROS[activeTab]}
                    </p>
                  )}

                  <TabsContent value="general">
                    <GeneralTab />
                  </TabsContent>

                  <TabsContent className="space-y-4" value="persona">
                    <PersonaTab
                      persona={persona}
                      defaultPersona={defaultPersona}
                      onSave={handleSavePersona}
                      onReset={handleResetPersona}
                      onDirtyChange={setPersonaDirty}
                    />
                  </TabsContent>

                  <TabsContent className="space-y-4" value="provider">
                    <ProviderTab
                      addModel={addModel}
                      addOllama={addOllama}
                      addGguf={addGguf}
                      addOpenaiProvider={addOpenaiProvider}
                      addNimProvider={() => setNimForm({})}
                      deleteModel={deleteModel}
                      deleteProvider={deleteProvider}
                      editModel={editModel}
                      editProvider={editProvider}
                      onProvidersChange={refreshProviders}
                      oaApiKey={oaApiKey}
                      oaBaseUrl={oaBaseUrl}
                      oaBusy={oaBusy}
                      oaError={oaError}
                      oaName={oaName}
                      ollamaBusy={ollamaBusy}
                      ollamaError={ollamaError}
                      openaiFormOpen={openaiFormOpen}
                      providers={providers}
                      setOaApiKey={setOaApiKey}
                      setOaBaseUrl={setOaBaseUrl}
                      setOaError={setOaError}
                      setOaName={setOaName}
                      setOpenaiFormOpen={setOpenaiFormOpen}
                    />
                  </TabsContent>

                  <TabsContent className="space-y-4" value="embedding">
                    <EmbeddingTab
                      detectBusy={detectBusy}
                      detectDimensions={detectDimensions}
                      detectResult={detectResult}
                      setDetectResult={setDetectResult}
                      embApiKey={embApiKey}
                      embApiKeyConfigured={embApiKeyConfigured}
                      clearEmbApiKey={clearEmbApiKey}
                      embBaseUrl={embBaseUrl}
                      embDimensions={embDimensions}
                      setEmbDimensions={setEmbDimensions}
                      embModel={embModel}
                      embSaveError={embSaveError}
                      embCanForceSave={embCanForceSave}
                      embeddingSaved={embeddingSaved}
                      embSource={embSource}
                      setEmbSource={setEmbSource}
                      legacyProviderName={embLegacyProviderName}
                      saveEmbedding={saveEmbedding}
                      setEmbApiKey={(value) => {
                        setEmbApiKey(value);
                        // Typing a key cancels a pending clear.
                        if (value) setEmbClearKey(false);
                      }}
                      setEmbBaseUrl={setEmbBaseUrl}
                      setEmbModel={setEmbModel}
                      onnxDiscoveredModels={settings?.onnxEmbedding?.discoveredModels ?? []}
                      onnxModelPath={embOnnxModelPath}
                      onnxLoaded={settings?.onnxEmbedding?.loaded ?? false}
                      setEmbOnnxModelPath={setEmbOnnxModelPath}
                      onModelInstalled={(repo) => handleModelInstalled("embedding", repo)}
                      installedModelNotification={installedModelNotification}
                      onDismissInstallNotification={() => setInstalledModelNotification(null)}
                    />
                  </TabsContent>

                  <TabsContent className="space-y-4" value="reranker">
                    <RerankerTab
                      enabled={rerankerEnabled}
                      provider={rerankerProvider}
                      baseUrl={rerankerBaseUrl}
                      remoteModel={rerankerRemoteModel}
                      apiKeyEnv={rerankerApiKeyEnv}
                      idleTimeoutMinutes={rerankerIdleTimeoutMinutes}
                      onChangeIdleTimeoutMinutes={handleChangeRerankerIdleTimeout}
                      onChangeProvider={handleRerankerProviderChange}
                      onChangeBaseUrl={handleRerankerBaseUrlChange}
                      onChangeRemoteModel={handleRerankerRemoteModelChange}
                      onChangeApiKeyEnv={handleRerankerApiKeyEnvChange}
                      onSave={handleSaveReranker}
                      onSelectModel={handleSelectRerankerModel}
                      onToggleEnabled={handleToggleReranker}
                      onModelInstalled={(repo) => handleModelInstalled("reranker", repo)}
                      onModelDeleted={handleRerankerModelDeleted}
                      installedModelNotification={installedModelNotification}
                      onDismissInstallNotification={() => setInstalledModelNotification(null)}
                      reranker={settings?.reranker ?? null}
                      saveError={rerankerSaveError}
                      saved={rerankerSaved}
                      saving={rerankerSaving}
                      selectedModel={rerankerSelectedModel}
                      probeBusy={rerankerProbeBusy}
                      probeResult={rerankerProbeResult}
                      onProbe={runRerankerProbe}
                    />
                  </TabsContent>

                  <TabsContent className="space-y-4" value="database">
                    <DatabaseTab
                      database={settings?.database ?? null}
                      maintenanceBusy={maintenanceBusy}
                      maintenanceNote={maintenanceNote}
                      runEmbeddingBackfillNow={runEmbeddingBackfillNow}
                      runMaintenancePass={runMaintenancePass}
                      dbBusy={dbBusy}
                      dbNote={dbNote}
                      dbNoteKind={dbNoteKind}
                      optimizeDatabase={optimizeDatabase}
                      resetDatabaseNow={resetDatabaseNow}
                      diagnostics={diagnostics}
                      diagnosticsBusy={diagnosticsBusy}
                      refreshDiagnostics={refreshDiagnostics}
                    />
                  </TabsContent>

                  <TabsContent className="space-y-4" value="tools">
                    <ToolsTab
                      mcpDuplicates={settings?.mcpDuplicates ?? []}
                      saveWebSearch={saveWebSearch}
                      toggleTool={toggleTool}
                      tools={settings?.tools ?? null}
                      toolsSaveError={toolsSaveError}
                      toolsSaved={toolsSaved}
                      updateWsForm={updateWsForm}
                      webSearch={settings?.webSearch ?? null}
                      wsForm={wsForm}
                      wsSaveError={wsSaveError}
                      wsSaved={wsSaved}
                    />
                  </TabsContent>

                  <TabsContent value="about">
                    <AboutTab about={settings?.about ?? null} />
                  </TabsContent>
                </div>
              </div>
            </div>
          </Tabs>

      <ProviderEditDialog
        open={editProviderDialogOpen}
        onOpenChange={(next) => {
          if (!next) {
            setEditProviderDialogOpen(false);
            setEditingProvider(null);
          }
        }}
        provider={editingProvider}
        name={editProvName}
        baseUrl={editProvBaseUrl}
        apiKey={editProvApiKey}
        clearKey={editProvClearKey}
        error={editProvError}
        busy={editProvBusy}
        onNameChange={setEditProvName}
        onBaseUrlChange={setEditProvBaseUrl}
        onApiKeyChange={setEditProvApiKey}
        onClearKeyChange={setEditProvClearKey}
        onCancel={() => setEditProviderDialogOpen(false)}
        onSave={handleSaveEditedProvider}
      />

      {nimForm && (
        <NimProviderDialog
          provider={nimForm.provider}
          onClose={() => setNimForm(null)}
          onSave={saveNimProvider}
        />
      )}

      <GgufAddDialog
        open={ggufDialogOpen}
        onOpenChange={setGgufDialogOpen}
        busy={ggufBusy}
        error={ggufError}
        serverFound={ggufServerFound}
        serverPath={ggufServerPath}
        serverVersion={ggufServerVersion}
        models={ggufModels}
        customServerPath={ggufCustomServerPath}
        onCustomServerPathChange={setGgufCustomServerPath}
        selectedModels={ggufSelectedModels}
        onSelectedModelsChange={setGgufSelectedModels}
        onReprobe={reprobeGgufServer}
        onConfirm={ggufDialogConfirm}
      />

      {/* Model Form Modal */}
      <ModelForm
        key={editingModel?.modelId ?? "new-model"}
        model={editingModel}
        onClose={() => {
          setModelFormOpen(false);
          setEditingModel(null);
        }}
        onSave={(entry) => void handleSaveModel(entry)}
        open={modelFormOpen}
        providerId={modelFormTargetProviderId}
        providerKind={
          providers.find((p) => p.id === modelFormTargetProviderId)?.kind
        }
      />

      <EmbeddingChangeDialog
        modelChanged={modelChanged}
        rebuildBusy={rebuildBusy}
        rebuildProgress={rebuildProgress}
        rebuildError={rebuildError}
        onDismiss={dismissModelChange}
        onRebuild={handleRebuildEmbeddings}
      />

      <ConfirmDialog
        open={confirmDiscardOpen}
        onOpenChange={setConfirmDiscardOpen}
        title="Unsaved changes"
        description="You have unsaved changes. Are you sure you want to close? They will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={confirmAndClose}
      />
        </DialogContent>
      </Dialog>
    </>
  );
}
