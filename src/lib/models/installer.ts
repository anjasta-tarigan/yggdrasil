import path from "node:path";
import { sanitizeSkillFilePath } from "@/lib/skills/config";
import type { HfClient } from "./hf-client";
import type { HfTreeEntry, HfModelInfo, ModelKind } from "./types";
import fs from "node:fs";
import { downloadFile, InsufficientDiskError, isSufficientDiskSpace, safeUnlink } from "./download";
import { runSmokeTest, ModelUnusableError } from "./smoke";
import { getModelDir, writeManifest, sweepOrphans, type ModelManifest } from "./store";
import { getJobRegistry, type InstallJob } from "./jobs";
import {
  isExcludedVariant,
  pickBestVariant,
  pickBestVariantWithSizes,
  cpuFallbackLadder,
} from "./variant-ladder";
import { resolvePoolingMode } from "@/lib/memory/pooling";
import { syslog } from "@/lib/observability/log-store";

export interface PlanFileItem {
  role: "graph" | "graph-data" | "tokenizer" | "pooling" | "companion";
  treePath: string;
  sourceUrl: string;
  destinationRelPath: string;
  sizeBytes: number;
  sha256?: string;
}

export interface OnnxVariantInfo {
  treePath: string;
  dataSizeBytes: number;
  dataSha256?: string;
}

export interface InstallPlan {
  repo: string;
  kind: ModelKind;
  chosenVariant: string;
  availableVariants: string[];
  onnxVariants: OnnxVariantInfo[];
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
    client.getModelInfo(repo).catch((err) => {
      syslog("debug", "installer", `getModelInfo ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      return { id: repo } as HfModelInfo;
    }),
  ]);

  const onnxFiles = tree.filter(t => t.type === "file" && t.path.endsWith(".onnx"));
  if (onnxFiles.length === 0) {
    throw new Error(`No ONNX models found in repository ${repo}`);
  }

  const availableVariants = onnxFiles.map(f => path.basename(f.path));

  // All ONNX variants with size + data file info for spec §4.1 (file-size-aware
  // selection) and spec §4.3 (fallback ladder with up to 3 attempts).
  const onnxVariants: OnnxVariantInfo[] = onnxFiles.map((f) => {
    const dataEntry = tree.find((t) => t.path === `${f.path}_data`);
    return {
      treePath: f.path,
      dataSizeBytes: dataEntry?.size ?? 0,
      dataSha256: dataEntry?.lfs?.oid,
    };
  });

  // Variant ladder is shared with the market's ranking so the variant the UI
  // advertises as best is the exact file downloaded here. Suffix-aware, which
  // matters for repos naming graphs `text_model_int8.onnx` rather than
  // `model_int8.onnx`; half-precision graphs (`_fp16`, and Optimum's `_O4`
  // export, which is also fp16) are never eligible — see variant-ladder.ts.
  let chosenTreeFile: HfTreeEntry | undefined;
  if (preferredVariant) {
    chosenTreeFile = onnxFiles.find(f => path.basename(f.path) === preferredVariant);
    if (chosenTreeFile && isExcludedVariant(chosenTreeFile.path)) {
      throw new Error(`Variant ${preferredVariant} is not usable on CPU (half-precision)`);
    }
  }
  if (!chosenTreeFile) {
    const bestPath = pickBestVariant(onnxFiles.map(f => f.path));
    chosenTreeFile = bestPath
      ? onnxFiles.find(f => f.path === bestPath)
      : undefined;
  }
  if (!chosenTreeFile) {
    throw new Error(`No usable ONNX variant found in repository ${repo}`);
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

  // 4. Pooling sidecar lookup (embedding models only)
  let poolingSourceRepo: string | undefined;
  if (kind === "embedding") {
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
    onnxVariants,
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

    // For pooling files without sha256 (e.g. from base_model), sizeBytes is just an estimate.
    // Do not enforce expectedBytes so it doesn't fail on byte count mismatch.
    const expectedBytes = (file.role === "pooling" && !file.sha256) ? undefined : file.sizeBytes;

    try {
      await downloadFile({
        client,
        url: file.sourceUrl,
        targetPath: dest,
        expectedBytes,
        expectedSha256: file.sha256,
        signal: job.abortController.signal,
        onProgress: (bytes) => {
          const delta = bytes - fileDownloaded;
          fileDownloaded = bytes;
          totalDownloaded += delta;
          job.bytesDownloaded = totalDownloaded;
        },
      });
    } catch (err) {
      if (file.role === "pooling") {
        // Pooling sidecar is optional; if unavailable on base repo, log and continue.
        syslog("info", "installer", `Optional pooling sidecar ${file.sourceUrl} unavailable: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      throw err;
    }
  }

  // Smoke test with CPU fallback (spec §4.3: exactly 3 attempts, QInt8→QUInt8→fp32)
  job.status = "smoke-testing";
  job.currentFile = undefined;

  const MAX_ATTEMPTS = 3;
  const variantLadder = cpuFallbackLadder(
    plan.onnxVariants.map((v) => ({
      path: v.treePath,
      sizeBytes: v.dataSizeBytes,
    })),
  );

  // The initially downloaded graph's variant name
  const initiallyPicked = path.basename(plan.chosenVariant);
  const tryVariant = (idx: number): string => {
    if (idx === 0) return initiallyPicked; // already downloaded
    return variantLadder[idx] ? path.basename(variantLadder[idx]) : initiallyPicked;
  };

  let smoke: { ok: boolean; error?: string; outputDims?: number[] } | undefined;
  let activeVariant = initiallyPicked;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidateName = tryVariant(attempt - 1);
    const candidatePath = path.join(targetDir, candidateName);

    if (candidateName !== initiallyPicked) {
      // Download fallback variant + its _data sidecar
      const variantEntry = plan.onnxVariants.find(
        (v) => path.basename(v.treePath) === candidateName,
      );
      if (!variantEntry) {
        syslog(
          "debug",
          "installer",
          `Fallback variant ${candidateName} not found in plan, skipping`,
        );
        continue;
      }

      // Clean slate for fallback graph
      safeUnlink(candidatePath);
      safeUnlink(`${candidatePath}_data`);

      try {
        const dataUrl = `https://huggingface.co/${plan.repo}/resolve/main/${variantEntry.treePath}_data`;
        await downloadFile({
          client,
          url: dataUrl,
          targetPath: path.join(targetDir, `${candidateName}_data`),
          expectedBytes: variantEntry.dataSizeBytes > 0 ? variantEntry.dataSizeBytes : undefined,
          expectedSha256: variantEntry.dataSha256,
          signal: job.abortController.signal,
          onProgress: () => {},
        });
      } catch (err) {
        syslog(
          "warn",
          "installer",
          `Fallback data sidecar download failed for ${candidateName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      activeVariant = candidateName;
    }

    try {
      smoke = await runSmokeTest(candidatePath);
    } catch (err) {
      smoke = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (smoke!.ok) {
      break;
    }

    syslog(
      "warn",
      "installer",
      `Smoke test attempt ${attempt}/${MAX_ATTEMPTS} failed for ${candidateName}: ${smoke!.error ?? "unknown"}`,
    );

    if (attempt === MAX_ATTEMPTS) {
      job.status = "failed";
      job.error = smoke!.error;
      throw new ModelUnusableError(
        `Smoke test failed after ${MAX_ATTEMPTS} attempts: ${smoke!.error ?? "unknown"}`,
      );
    }
  }

  // Resolve pooling mode from real dims
  let poolingMode: string | undefined;
  if (smoke!.outputDims) {
    const res = resolvePoolingMode(path.join(targetDir, activeVariant), smoke!.outputDims);
    if (res.kind === "resolved") poolingMode = res.mode;
    else if (res.kind === "already-pooled") poolingMode = "already-pooled";
  }

  // Write manifest LAST as the completion marker
  const manifest: ModelManifest = {
    schemaVersion: 1,
    repo: plan.repo,
    kind: plan.kind,
    variant: activeVariant,
    files: plan.files.map(f => f.destinationRelPath),
    sizeBytes: plan.totalBytes,
    poolingMode,
    installedAt: new Date().toISOString(),
  };
  writeManifest(targetDir, manifest);

  job.status = "completed";
}
