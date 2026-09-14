#!/usr/bin/env node
/**
 * Isolated child-process smoke test for ONNX models.
 *
 * Pure ESM (.mjs) so it executes under plain Node.js without ts-node or
 * tsx loader hooks. Spawned by src/lib/models/smoke.ts via child_process.fork().
 *
 * Ruling: The original plan imported `loadOrt` from ../memory/onnx-session.js,
 * but that source file is .ts and this worker runs in a forked Node process
 * with no TS loader or @/-alias resolution. The worker imports
 * onnxruntime-node directly instead — the only difference vs loadOrt is the
 * test-only customOrtLoader hook, irrelevant for a real child process.
 *
 * Isolation rationale: ONNX graphs from untrusted sources can trigger native
 * crashes (SIGSEGV, SIGABRT, SIGFPE). Running in a separate OS process
 * guarantees the host server survives and the OS unmaps 100% of native memory
 * on exit.
 */
const modelPath = process.argv[2];
if (!modelPath) {
  process.stderr.write("usage: smoke-worker.mjs <modelPath>\n");
  process.exit(1);
}

try {
  const mod = await import("onnxruntime-node");
  // onnxruntime-node is CJS; under ESM the default export is module.exports.
  const ort = mod.default ?? mod;

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    enableCpuMemArena: false,
    enableMemPattern: false,
    executionMode: "sequential",
  });

  // Build dummy feeds for declared input names.
  // Dummy token ids [0, 1] and mask [1, 1], seq length 2 — only probing
  // that the graph loads and executes, not producing real embeddings.
  const feeds = {};
  const ids = new BigInt64Array([0n, 1n]);
  const mask = new BigInt64Array([1n, 1n]);
  const zeros = new BigInt64Array([0n, 0n]);

  for (const name of session.inputNames) {
    switch (name) {
      case "input_ids":
        feeds[name] = new ort.Tensor("int64", ids, [1, 2]);
        break;
      case "attention_mask":
        feeds[name] = new ort.Tensor("int64", mask, [1, 2]);
        break;
      case "token_type_ids":
        feeds[name] = new ort.Tensor("int64", zeros, [1, 2]);
        break;
    }
  }

  const out = await session.run(feeds);

  // Extract output rank for pooling tier-1 resolution (2-D = already pooled).
  const targetTensor =
    out.last_hidden_state ??
    out.sentence_embedding ??
    out.output ??
    Object.values(out)[0];
  const dims = targetTensor?.dims ?? [1, 0];

  await session.release();

  const result = { ok: true, outputDims: Array.from(dims) };
  if (process.send) {
    process.send(result, () => process.exit(0));
  } else {
    process.exit(0);
  }
} catch (err) {
  const error = err instanceof Error ? err.message : String(err);
  const result = { ok: false, error };
  if (process.send) {
    process.send(result, () => process.exit(1));
  } else {
    process.exit(1);
  }
}
