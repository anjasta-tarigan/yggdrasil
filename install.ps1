# install.ps1 - Windows PowerShell Bootstrap Installer for Yggdrasil
#
# Two modes:
#   1. Default: resolves the latest GitHub release (or $env:YGGDRASIL_VERSION),
#      downloads the release-asset copy of this script plus its .sha256
#      companion, verifies it with Get-FileHash, and runs the verified copy.
#      This self-verification trampoline guards against a tampered copy of
#      this script being served to the user (Codecov-style supply-chain attack).
#   2. -Verified (set by phase 1 on the downloaded copy, or via
#      $env:YGGDRASIL_CHANNEL = "main" for development installs tracking main):
#      checks prerequisites, clones the repo, builds it, and hands off to
#      the CLI installer.
#
# Usage: irm https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.ps1 | iex
#        (or: .\install.ps1 [-TargetDir <dir>])

param (
    [string]$TargetDir = "$env:USERPROFILE\.yggdrasil",
    [switch]$Verified
)

$ErrorActionPreference = "Stop"

# Refuse plain HTTP and TLS < 1.2, so the installer and its checksum cannot be
# swapped by a network attacker. Windows PowerShell 5.1 defaults to TLS 1.0.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

# --- OS guard: this installer is Windows-only. ---------------------------------
# Route POSIX users to install.sh before any download. $IsLinux/$IsMacOS are
# PowerShell 7 automatic variables; on Windows PowerShell 5.1 (Windows-only) they
# are undefined (false), so the guard is a no-op there. Do NOT key this off
# $env:OS — PowerShell 7 on Linux sets it to "Windows_NT".
if ($IsLinux -or $IsMacOS) {
    Write-Host "This installer is for Windows only. On your platform use the POSIX installer:"
    Write-Host "  curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash"
    Write-Host ""
    Write-Host "Aborting."
    exit 1
}

# Prints a loud FAILURE banner and stops the install with a non-zero exit code.
# Uses Write-Host (NOT Write-Error): under $ErrorActionPreference = "Stop",
# Write-Error becomes a terminating error and would bypass this banner entirely.
function Fail-Step([string]$Step) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Red
    Write-Host "  YGGDRASIL INSTALLATION FAILED" -ForegroundColor Red
    Write-Host "  (during step: $Step)" -ForegroundColor Red
    Write-Host "==========================================" -ForegroundColor Red
    Write-Host "See the error output above. Re-run the installer, or inspect the"
    Write-Host "logs under your TargetDir\data\logs."
    exit 1
}

$GithubOwnerRepo = "anjasta-tarigan/yggdrasil"
$LatestApiUrl = "https://api.github.com/repos/$GithubOwnerRepo/releases/latest"
$AssetBaseUrl = "https://github.com/$GithubOwnerRepo/releases/download"

# Resolves a release tag (e.g. v0.3.7) to its underlying commit SHA.
# The project publishes *annotated* tags (git tag -a), so the tag ref points at a
# tag object rather than a commit, and `git clone --branch <annotated-tag>` fails on
# a shallow clone with "refs/tags/X is not a commit". We ask the GitHub API for the
# commit the tag resolves to (`/commits/<tag>` dereferences annotated tags
# automatically and returns the real commit SHA in one call), then clone by that
# SHA, which always succeeds.
function Resolve-TagCommit([string]$Tag) {
    try {
        $headers = @{ "User-Agent" = "yggdrasil-installer" }
        if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
        elseif ($env:GH_TOKEN) { $headers["Authorization"] = "Bearer $env:GH_TOKEN" }
        $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/$GithubOwnerRepo/commits/$Tag" -Headers $headers -TimeoutSec 15
        if ($commit -and $commit.sha -match "^[0-9a-f]{40}$") { return $commit.sha }
    } catch {
        # fall through to $null
    }
    return $null
}

if (-not $Verified -and $env:YGGDRASIL_CHANNEL -ne "main") {
    # --- Phase 1: verify this installer against the published release. ------
    # YGGDRASIL_VERSION pins a specific release tag; default is "latest".
    $version = if ($env:YGGDRASIL_VERSION) { $env:YGGDRASIL_VERSION } else {
        Write-Host "[Yggdrasil] Resolving latest release..."
        $v = $null
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                $headers = @{ "User-Agent" = "yggdrasil-installer" }
                if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
                elseif ($env:GH_TOKEN) { $headers["Authorization"] = "Bearer $env:GH_TOKEN" }
                $v = (Invoke-RestMethod -Uri $LatestApiUrl -Headers $headers -TimeoutSec 15).tag_name
                if ($v) { break }
            } catch {
                Start-Sleep -Seconds 1
            }
        }
        $v
    }
    if (-not $version) {
        Write-Error "Could not resolve the latest Yggdrasil release. Set `$env:YGGDRASIL_CHANNEL='main' to install from the main branch, or set `$env:YGGDRASIL_VERSION='<tag>' to pin one."
        exit 1
    }
    Write-Host "[Yggdrasil] Using release $version."

    $scriptPath = Join-Path $env:TEMP "yggdrasil-install.ps1"
    $hashPath = Join-Path $env:TEMP "yggdrasil-install.ps1.sha256"

    Write-Host "[Yggdrasil] Downloading installer and checksum for $version..."
    try {
        Invoke-WebRequest -Uri "$AssetBaseUrl/$version/install.ps1" -OutFile $scriptPath -TimeoutSec 30
        Invoke-WebRequest -Uri "$AssetBaseUrl/$version/install.ps1.sha256" -OutFile $hashPath -TimeoutSec 30
    } catch {
        Write-Error "Failed to download install.ps1 from release $version."
        exit 1
    }

    # The .sha256 companion is "<hex digest>  install.ps1" (sha256sum format).
    $expectedHash = (Get-Content $hashPath).Trim().Split(" ")[0]
    $actualHash = (Get-FileHash -Path $scriptPath -Algorithm SHA256).Hash.ToLower()
    if ($expectedHash.ToLower() -ne $actualHash) {
        Write-Error "ERROR: Checksum verification failed for Yggdrasil installer! Aborting."
        exit 1
    }
    Write-Host "[Yggdrasil] Checksum verified."

    $env:YGGDRASIL_VERSION = $version
    # -Verified is consumed here, never forwarded to the CLI installer.
    & $scriptPath -TargetDir $TargetDir -Verified
    exit $LASTEXITCODE
}

# --- Phase 2: verified installer (direct flow). -----------------------------
Write-Host "[Yggdrasil] Checking system prerequisites..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is required but not installed. Please install Git: https://git-scm.com/"
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js (>=24.0.0) is required but not installed. Please install Node.js: https://nodejs.org/"
    exit 1
}

# Node >= 24.0.0 is required for node:sqlite built-in module: parse major.minor
# and compare numerically.
$nodeVersion = (node --version).TrimStart("v") # e.g. 24.0.0
$nodeParts = $nodeVersion.Split(".")
if ([int]$nodeParts[0] -lt 24) {
    Write-Error "Node.js (>=24.0.0) is required, but found v$nodeVersion. Please update Node.js: https://nodejs.org/"
    exit 1
}
Write-Host "[Yggdrasil] Node.js v$nodeVersion detected."

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "[Yggdrasil] pnpm not found. Attempting automatic setup..."
    $installedPnpm = $false
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        try {
            corepack enable pnpm
            $installedPnpm = $true
        } catch { }
    }
    if (-not $installedPnpm -and (Get-Command npm -ErrorAction SilentlyContinue)) {
        try {
            npm install -g pnpm
            $installedPnpm = $true
        } catch { }
    }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Error "Failed to locate or install pnpm. Please install pnpm: https://pnpm.io/installation"
        exit 1
    }
}
# pnpm may have just been installed via corepack/npm into a directory that is
# not yet on this shell's resolved PATH (e.g. corepack shims). Re-query so the
# build step below finds it without the user reopening the terminal first.
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    $env:Path = [string]::Join(";", @($env:Path, "$env:APPDATA\npm", "$env:LOCALAPPDATA\pnpm", "$env:LOCALAPPDATA\Microsoft\WinGet\Links"))
}
Write-Host "[Yggdrasil] pnpm ready."

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
$appDir = Join-Path $TargetDir "app"

# A release install pins the code to the verified release tag; the main channel
# tracks main. `yggdrasil update` moves any install onto main afterwards.
$checkoutRef = if ($env:YGGDRASIL_VERSION) { $env:YGGDRASIL_VERSION } else { "main" }

# Annotated tags cannot be cloned directly on a shallow clone; resolve to the
# underlying commit SHA so `git clone --branch <sha>` always succeeds.
$cloneRef = $checkoutRef
if ($checkoutRef -ne "main") {
    $resolvedSha = Resolve-TagCommit $checkoutRef
    if (-not $resolvedSha) {
        Write-Error "Could not resolve commit for tag $checkoutRef. The release may have been removed."
        exit 1
    }
    $cloneRef = $resolvedSha
}

# A prior (failed) install can leave a partial or detached .git behind (e.g. an
# annotated-tag clone that aborted with "refs/tags/X is not a commit" and left a
# detached HEAD). Re-running against that contaminated repo silently reuses the
# broken state. Detect a corrupt/inconsistent local repo and start from scratch.
$repoOk = $false
if (Test-Path (Join-Path $appDir ".git")) {
    $headSha = (git -C $appDir rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $headSha) { $repoOk = $true }
    if (-not $repoOk) {
        Write-Host "[Yggdrasil] Removing corrupt existing repository at $appDir..."
        Remove-Item -Recurse -Force $appDir -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path (Join-Path $appDir ".git"))) {
    Write-Host "[Yggdrasil] Cloning $checkoutRef ($cloneRef) to $appDir..."
    git clone --depth 1 --branch $cloneRef "https://github.com/$GithubOwnerRepo.git" $appDir
    if ($LASTEXITCODE -ne 0) { Fail-Step "git clone $checkoutRef" }
} elseif ($checkoutRef -eq "main") {
    Write-Host "[Yggdrasil] Existing repository detected at $appDir. Fetching updates..."
    git -C $appDir fetch --depth 1 origin main:refs/remotes/origin/main
    git -C $appDir checkout -B main origin/main
} else {
    Write-Host "[Yggdrasil] Existing repository detected at $appDir. Fetching release $checkoutRef..."
    $updSha = Resolve-TagCommit $checkoutRef
    if (-not $updSha) {
        Write-Error "Could not resolve commit for tag $checkoutRef. The release may have been removed."
        exit 1
    }
    # Fetch the commit directly (annotated-tag refs are unreliable on shallow).
    git -C $appDir fetch --depth 1 origin $updSha
    git -C $appDir checkout $updSha
    if ($LASTEXITCODE -ne 0) { Fail-Step "git checkout $checkoutRef" }
}

# Verify we actually landed on the intended commit. A mismatch means the clone or
# checkout silently diverged (the exact failure mode that left prior installs on a
# detached HEAD with the wrong code); never proceed silently in that case.
$actualHead = (git -C $appDir rev-parse HEAD 2>$null)
if ($cloneRef -ne "main" -and $actualHead -ne $cloneRef) {
    Fail-Step "git checkout landed on $actualHead, expected $cloneRef"
}

Set-Location $appDir
$env:NODE_OPTIONS = if ($env:NODE_OPTIONS) { $env:NODE_OPTIONS } else { "--max-old-space-size=2048" }
$env:NODE_ENV = "production"

Write-Host "[Yggdrasil] Installing dependencies..."
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  Write-Host "[Yggdrasil] Frozen install failed; retrying full install..."
  pnpm install
}
if ($LASTEXITCODE -ne 0) { Fail-Step "pnpm install" }

Write-Host "[Yggdrasil] Clearing Next.js build cache..."
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$appDir\.next"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$appDir\.turbo"

Write-Host "[Yggdrasil] Building production Next.js application..."
pnpm build
if ($LASTEXITCODE -ne 0) {
    # A stale .next or a tight heap can fail the build; retry once with a larger
    # V8 heap ceiling (max-old-space-size is appended, not overwritten, so any
    # caller-supplied NODE_OPTIONS still wins for other flags).
    Write-Host "[Yggdrasil] Build failed; retrying with larger heap..."
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --max-old-space-size=4096"
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$appDir\.next"
    pnpm build
    if ($LASTEXITCODE -ne 0) { Fail-Step "pnpm build" }
}

Write-Host "[Yggdrasil] Running CLI installer..."
node bin\yggdrasil.mjs install --dir $TargetDir
if ($LASTEXITCODE -ne 0) { Fail-Step "yggdrasil install" }

Write-Host ""
Write-Host "=========================================="
Write-Host " Yggdrasil installation complete!"
Write-Host "=========================================="
Write-Host "  URL:  http://localhost:2302"
Write-Host "  Data: $TargetDir\data"
Write-Host "  Logs: $TargetDir\data\logs"
Write-Host ""
Write-Host "  Service: registered as a Windows scheduled task (starts at logon)"
Write-Host "  CLI:     'yggdrasil' command added to user PATH"
Write-Host ""
Write-Host "  NOTE: Close and reopen this terminal for 'yggdrasil' to work."
Write-Host "=========================================="
exit 0
