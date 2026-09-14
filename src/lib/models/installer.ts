import fs from "node:fs";
import path from "node:path";
import { sanitizeSkillFilePath } from "@/lib/skills/config";
import type { HfClient } from "./hf-client";
import type { HfTreeEntry, HfModelInfo, ModelKind } from "./types";
import { downloadFile, InsufficientDiskError, isSufficientDiskSpace } from "./download";
import { runSmokeTest, ModelUnusableError } from "./smoke";
import { getModelDir, writeManifest, sweepOrphans, type ModelManifest } from "./store";
import { getJobRegistry, type InstallJob } from "./jobs";
import { resolvePoolingMode } from "@/lib/memory/pooling";

export interface PlanFileItem {
  role: "graph" | "graph-data" | "tokenizer" | "pooling" | "companion";
  treePath: string;
  sourceUrl: string;
  destinationRelPath: string;
  sizeBytes: number;
  sha256?: string;
}

export interface InstallPlan {
  repo: string;
  kind: ModelKind;
  chosenVariant: string;
  availableVariants: string[];
  files: PlanFileItem[];
  totalBytes: number;
  poolingSourceRepo?: string;
}

const COMPANION_ALLOWLIST = new Set([
  "config.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "sentencepiece.bpe.model",
  "spiece.model",
  "vocab.txt",
  "quant_config.json",
  "quantize_config.json",
  "modules.json",
]);

const REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export async function planInstall(options: {
  repo: string;
  kind: ModelKind;
  client: HfClient;
  preferredVariant?: string;
}): Promise<InstallPlan> {
  const { repo, kind, client, preferredVariant } = options;
  if (!REPO_RE.test(repo)) {
    throw new Error(`Invalid repository format: ${repo}`);
  }

  const [tree, info] = await Promise.all([
    client.getModelTree(repo),
    client.getModelInfo(repo).catch(() => ({ id: repo })) as Promise<HfModelInfo>,
  ]);

  const onnxFiles = tree.filter(t => t.type === "file" && t.path.endsWith(".onnx"));
  if (onnxFiles.length === 0) {
    throw new Error(`No ONNX models found in repository ${repo}`);
  }

  const availableVariants = onnxFiles.map(f => path.basename(f.path));

  // Variant ladder: int8/quantized -> uint8 -> fp32
  let chosenTreeFile: HfTreeEntry | undefined;
  if (preferredVariant) {
    chosenTreeFile = onnxFiles.find(f => path.basename(f.path) === preferredVariant);
  }
  if (!chosenTreeFile) {
    chosenTreeFile = onnxFiles.find(f => path.basename(f.path) === "model_int8.onnx") ??
      onnxFiles.find(f => path.basename(f.path) === "model_quantized.onnx") ??
      onnxFiles.find(f => path.basename(f.path) === "model_uint8.onnx") ??
      onnxFiles.find(f => path.basename(f.path) === "model.onnx") ??
      onnxFiles[0];
  }

  const chosenVariant = path.basename(chosenTreeFile.path);
  const files: PlanFileItem[] = [];

  // 1. Graph file (flattened)
  files.push({
    role: "graph",
    treePath: chosenTreeFile.path,
    sourceUrl: `https://huggingface.co/${repo}/resolve/main/${chosenTreeFile.path}`,
    destinationRelPath: chosenVariant,
    sizeBytes: chosenTreeFile.size,
    sha256: chosenTreeFile.lfs?.oid,
  });

  // 2. Sibling external data
  const dataTreePath = `${chosenTreeFile.path}_data`;
  const dataFile = tree.find(t => t.path === dataTreePath);
  if (dataFile) {
    files.push({
      role: "graph-data",
      treePath: dataFile.path,
      sourceUrl: `https://huggingface.co/${repo}/resolve/main/${dataFile.path}`,
      destinationRelPath: `${chosenVariant}_data`,
      sizeBytes: dataFile.size,
      sha256: dataFile.lfs?.oid,
    });
  }

  // 3. Tokenizer
  const tokenizerFile = tree.find(t => t.path === "tokenizer.json" || t.path.endsWith("/tokenizer.json"));
  if (tokenizerFile) {
    files.push({
      role: "tokenizer",
      treePath: tokenizerFile.path,
      sourceUrl: `https://huggingface.co/${repo}/resolve/main/${tokenizerFile.path}`,
      destinationRelPath: "tokenizer.json",
      sizeBytes: tokenizerFile.size,
      sha256: tokenizerFile.lfs?.oid,
    });
  }

  // 4. Pooling sidecar lookup
  let poolingSourceRepo: string | undefined;
  const directPooling = tree.find(t => t.path === "1_Pooling/config.json");
  if (directPooling) {
    files.push({
      role: "pooling",
      treePath: directPooling.path,
      sourceUrl: `https://huggingface.co/${repo}/resolve/main/${directPooling.path}`,
      destinationRelPath: "1_Pooling/config.json",
      sizeBytes: directPooling.size,
    });
  } else if (info.tags) {
    // Find base_model:<repo>
    const baseTag = info.tags.find(t => t.startsWith("base_model:") && !t.startsWith("base_model:quantized:"));
    if (baseTag) {
      const baseRepo = baseTag.slice("base_model:".length);
      poolingSourceRepo = baseRepo;
      files.push({
        role: "pooling",
        treePath: "1_Pooling/config.json",
        sourceUrl: `https://huggingface.co/${baseRepo}/resolve/main/1_Pooling/config.json`,
        destinationRelPath: "1_Pooling/config.json",
        sizeBytes: 1024,
      });
    }
  }

  // 5. Allowlisted companion files
  for (const t of tree) {
    if (t.type !== "file") continue;
    const base = path.basename(t.path);
    if (COMPANION_ALLOWLIST.has(base) && base !== "tokenizer.json") {
      files.push({
        role: "companion",
        treePath: t.path,
        sourceUrl: `https://huggingface.co/${repo}/resolve/main/${t.path}`,
        destinationRelPath: base,
        sizeBytes: t.size,
      });
    }
  }

  const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
  return {
    repo,
    kind,
    chosenVariant,
    availableVariants,
    files,
    totalBytes,
    poolingSourceRepo,
  };
}

export async function executeInstall(job: InstallJob, plan: InstallPlan, client: HfClient): Promise<void> {
  const targetDir = getModelDir(plan.kind, plan.repo);
  const activeDirs = getJobRegistry().getActiveJobDirs();
  sweepOrphans(plan.kind, activeDirs);

  // Reserve disk: check against total bytes needed.
  if (!isSufficientDiskSpace(plan.totalBytes, targetDir)) {
    throw new InsufficientDiskError(`Insufficient disk space: ${plan.totalBytes} bytes required`);
  }

  job.status = "downloading";
  job.estimatedBytes = plan.totalBytes;

  let totalDownloaded = 0;
  for (const file of plan.files) {
    if (job.abortController.signal.aborted) {
      job.status = "aborted";
      throw new Error("Install aborted by user");
    }

    const cleanRel = sanitizeSkillFilePath(file.destinationRelPath);
    if (!cleanRel) {
      throw new Error(`Unsafe destination path in plan: ${file.destinationRelPath}`);
    }
    const dest = path.resolve(targetDir, cleanRel);
    if (!dest.startsWith(targetDir + path.sep)) {
      throw new Error(`Security Violation: Path escapes target directory: ${dest}`);
    }

    job.currentFile = file.destinationRelPath;
    let fileDownloaded = 0;

    await downloadFile({
      client,
      url: file.sourceUrl,
      targetPath: dest,
      expectedBytes: file.sizeBytes,
      expectedSha256: file.sha256,
      signal: job.abortController.signal,
      onProgress: (bytes) => {
        const delta = bytes - fileDownloaded;
        fileDownloaded = bytes;
        totalDownloaded += delta;
        job.bytesDownloaded = totalDownloaded;
      },
    });
  }

  // Smoke test isolated in child process
  job.status = "smoke-testing";
  job.currentFile = undefined;

  const modelPath = path.join(targetDir, plan.chosenVariant);
  const smoke = await runSmokeTest(modelPath);

  if (!smoke.ok) {
    job.status = "failed";
    job.error = smoke.error;
    throw new ModelUnusableError(`Smoke test failed: ${smoke.error}`);
  }

  // Resolve pooling mode from real dims
  let poolingMode: string | undefined;
  if (smoke.outputDims) {
    const res = resolvePoolingMode(modelPath, smoke.outputDims);
    if (res.kind === "resolved") poolingMode = res.mode;
    else if (res.kind === "already-pooled") poolingMode = "already-pooled";
  }

  // Write manifest LAST as the completion marker
  const manifest: ModelManifest = {
    schemaVersion: 1,
    repo: plan.repo,
    kind: plan.kind,
    variant: plan.chosenVariant,
    files: plan.files.map(f => f.destinationRelPath),
    sizeBytes: plan.totalBytes,
    poolingMode,
    installedAt: new Date().toISOString(),
  };
  writeManifest(targetDir, manifest);

  job.status = "completed";
}
