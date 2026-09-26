#!/usr/bin/env node
// scripts/release.mjs
//
// One-command production release for Yggdrasil.
//
// Run from the `development` branch:
//
//   pnpm release patch    # 0.1.0 -> 0.1.1
//   pnpm release minor    # 0.1.0 -> 0.2.0
//   pnpm release major    # 0.1.0 -> 1.0.0
//   pnpm release 2.3.1    # explicit version
//
// The script promotes `development` into `main`, tags the release, and pushes
// both. Pushing the tag triggers `.github/workflows/release.yml`, which
// type-checks, regenerates the installer SHA-256 companions, and publishes the
// GitHub Release assets. No manual checksum step is needed here.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dirname` needs Node >= 20.11; the project floor is 20.9.0.
const PACKAGE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../package.json"
);
const RELEASE_BRANCH = "development";
const PRODUCTION_BRANCH = "main";

function run(command, args) {
  // stdio: "inherit" keeps git/pnpm output visible; a non-zero exit throws.
  return execFileSync(command, args, { stdio: "inherit", encoding: "utf8" });
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

/** `0.1.0` + "patch" -> `0.1.1`; an explicit `x.y.z` passes through. */
function resolveNextVersion(current, target) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!parsed) fail(`package.json version "${current}" is not valid semver.`);
  const [, major, minor, patch] = parsed.map(Number);

  switch (target) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      if (!/^\d+\.\d+\.\d+$/.test(target)) {
        fail(`Unknown release target "${target}". Use patch, minor, major, or an explicit x.y.z.`);
      }
      return target;
  }
}

const target = process.argv[2];
if (!target) {
  fail("Missing release target. Usage: pnpm release <patch|minor|major|x.y.z>");
}

const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== RELEASE_BRANCH) {
  fail(`Releases must run from "${RELEASE_BRANCH}" (currently on "${branch}").`);
}

if (capture("git", ["status", "--porcelain"]).length > 0) {
  fail("Working tree is dirty. Commit or stash changes before releasing.");
}

run("git", ["fetch", "origin", RELEASE_BRANCH]);

const behind = capture("git", ["rev-list", "--count", `HEAD..origin/${RELEASE_BRANCH}`]);
if (behind !== "0") {
  fail(`Local ${RELEASE_BRANCH} is ${behind} commit(s) behind origin. Pull first.`);
}

const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
const nextVersion = resolveNextVersion(pkg.version, target);
const tag = `v${nextVersion}`;

if (capture("git", ["tag", "-l", tag]).length > 0) {
  fail(`Tag ${tag} already exists. Choose a higher version.`);
}

if (pkg.version === nextVersion) {
  // A previous attempt already committed this bump but failed later (e.g. the
  // merge into main). Resume from here rather than trying to commit an
  // unchanged package.json, which would abort the whole release.
  console.log(`[release] package.json is already at ${nextVersion}; resuming.`);
} else {
  console.log(`[release] Bumping ${pkg.version} -> ${nextVersion}`);
  pkg.version = nextVersion;
  writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

  run("git", ["add", "package.json"]);
  run("git", ["commit", "-m", `chore(release): ${tag}`]);
  run("git", ["push", "origin", RELEASE_BRANCH]);
}

console.log(`[release] Merging ${RELEASE_BRANCH} -> ${PRODUCTION_BRANCH}`);
run("git", ["fetch", "origin", PRODUCTION_BRANCH]);
run("git", ["checkout", PRODUCTION_BRANCH]);
try {
  // Sync local main to origin/main before merging. main may have advanced since
  // this clone last saw it (e.g. a PR merged with a merge commit); merging onto
  // a stale main would produce a push the remote rejects.
  run("git", ["merge", "--ff-only", `origin/${PRODUCTION_BRANCH}`]);
  // A regular merge, NOT --ff-only. Once a PR is merged with a merge commit,
  // main holds commits development does not, so a fast-forward is impossible.
  // This fast-forwards when it can and writes a merge commit when it cannot.
  run("git", ["merge", "--no-edit", RELEASE_BRANCH]);
  run("git", ["push", "origin", PRODUCTION_BRANCH]);
  run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  run("git", ["push", "origin", tag]);
} finally {
  // Always return to the working branch, even when a step above throws.
  run("git", ["checkout", RELEASE_BRANCH]);
}

console.log(`[release] Tagged ${tag}. GitHub Actions is publishing the release assets.`);
console.log(`[release] https://github.com/anjasta-tarigan/yggdrasil/releases/tag/${tag}`);
