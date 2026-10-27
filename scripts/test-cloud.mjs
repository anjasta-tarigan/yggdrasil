#!/usr/bin/env node
// scripts/test-cloud.mjs
//
// Run the test suite on a GitHub-hosted runner instead of this machine.
//
// The local suite is the slow path (8 GB / 4 cores, `maxWorkers: 2`): a full
// `pnpm test` takes close to an hour. This wrapper dispatches the `full-suite`
// job in .github/workflows/ci.yml, waits for it, and surfaces the result plus
// the failing test names.
//
// Usage:
//   pnpm test:cloud                 # unit suite on the current branch
//   pnpm test:cloud --scope all     # unit + integration
//   pnpm test:cloud --scope cli     # the fast CLI/installer subset
//   pnpm test:cloud --push          # push the current branch first (opt-in)
//
// Safety: the working tree must be clean and the commit must already be on the
// remote. Nothing is pushed unless `--push` is passed, so uncommitted work is
// reported instead of silently shipped.

import { spawnSync } from "node:child_process";

const WORKFLOW = "ci.yml";
const ARTIFACT = "test-report";
const SCOPES = new Set(["unit", "all", "cli"]);
const MAX_BUFFER = 32 * 1024 * 1024;

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(name);
}

function option(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function fail(message) {
  console.error(`[test:cloud] ${message}`);
  process.exit(1);
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(`Could not run \`${command}\`: ${result.error.message}`);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 && !allowFailure) {
    fail(`\`${command} ${args.join(" ")}\` failed:\n${output}`);
  }
  return output;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tryRun(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ""}`.trim();
}

const scope = option("--scope", "unit");
if (!SCOPES.has(scope)) {
  fail(`Unknown --scope "${scope}". Use one of: ${[...SCOPES].join(", ")}.`);
}

if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) {
  fail("`gh` is not authenticated. Run `gh auth login` first.");
}

const branch =
  option("--branch", "") ||
  run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).split("\n").pop();
if (!branch || branch === "HEAD") {
  fail("Detached HEAD: check out a branch before running the cloud suite.");
}

if (run("git", ["status", "--porcelain"])) {
  fail(
    "Working tree is dirty. Commit first: the cloud run tests the pushed commit, not local edits."
  );
}

const headSha = run("git", ["rev-parse", "HEAD"]).split("\n").pop();
const remoteSha = tryRun("git", ["rev-parse", `origin/${branch}`]);

if (remoteSha !== headSha) {
  if (flag("--push")) {
    console.log(`[test:cloud] Pushing ${branch} to origin...`);
    run("git", ["push", "-u", "origin", branch]);
  } else {
    fail(
      `${branch} is not pushed (local ${headSha.slice(0, 7)}, remote ${
        remoteSha ? remoteSha.slice(0, 7) : "missing"
      }).\nRun \`git push\` first, or re-run with --push.`
    );
  }
}

console.log(
  `[test:cloud] Dispatching ${WORKFLOW} (scope=${scope}) on ${branch}...`
);
run("gh", ["workflow", "run", WORKFLOW, "--ref", branch, "-f", `scope=${scope}`]);

// The dispatch API returns no run id, so poll the branch's runs until the one
// for this commit appears (runners can take ~10 s to register it).
const runId = await waitForRun(headSha);
console.log(`[test:cloud] Watching run ${runId}...`);
const watched = spawnSync("gh", ["run", "watch", runId, "--exit-status"], {
  stdio: "inherit",
});

let conclusion = "unknown";
let url = "";
try {
  const parsed = JSON.parse(
    run("gh", ["run", "view", runId, "--json", "conclusion,url"])
  );
  conclusion = parsed.conclusion ?? "unknown";
  url = parsed.url ?? "";
} catch {
  // Keep the fallbacks; the watch exit code still decides success below.
}

if (watched.status !== 0 || conclusion === "failure") {
  console.error(`\n[test:cloud] FAILED — ${url}`);
  const log = run("gh", ["run", "view", runId, "--log-failed"], {
    allowFailure: true,
  });
  if (log) {
    console.error(log.split("\n").slice(-120).join("\n"));
  }
  process.exit(1);
}

console.log(`\n[test:cloud] PASSED — ${url}`);
console.log(
  `[test:cloud] Report: gh run download ${runId} -n ${ARTIFACT}\n` +
    "[test:cloud] Failures are also listed in the run's job summary."
);

async function waitForRun(sha) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const raw = run(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        WORKFLOW,
        "--branch",
        branch,
        // A push to the same commit also starts a run; only match the one this
        // script dispatched.
        "--event",
        "workflow_dispatch",
        "--limit",
        "10",
        "--json",
        "databaseId,headSha",
      ],
      { allowFailure: true }
    );
    try {
      const runs = JSON.parse(raw);
      const match = runs.find((candidate) => candidate.headSha === sha);
      if (match) return String(match.databaseId);
    } catch {
      // Transient gh/network output; retry.
    }
    await sleep(3000);
  }
  return fail(`No workflow run appeared for ${sha.slice(0, 7)} on ${branch}.`);
}
