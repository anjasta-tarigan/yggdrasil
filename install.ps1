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

$GithubOwnerRepo = "anjasta-tarigan/yggdrasil"
$LatestApiUrl = "https://api.github.com/repos/$GithubOwnerRepo/releases/latest"
$AssetBaseUrl = "https://github.com/$GithubOwnerRepo/releases/download"

if (-not $Verified -and $env:YGGDRASIL_CHANNEL -ne "main") {
    # --- Phase 1: verify this installer against the published release. ------
    # YGGDRASIL_VERSION pins a specific release tag; default is "latest".
    $version = if ($env:YGGDRASIL_VERSION) { $env:YGGDRASIL_VERSION } else {
        Write-Host "[Yggdrasil] Resolving latest release..."
        try {
            $headers = @{}
            if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
            elseif ($env:GH_TOKEN) { $headers["Authorization"] = "Bearer $env:GH_TOKEN" }
            (Invoke-RestMethod -Uri $LatestApiUrl -Headers $headers -TimeoutSec 15).tag_name
        } catch {
            $null
        }
    }
    if (-not $version) {
        if ($env:YGGDRASIL_VERSION) {
            Write-Error "Could not resolve the specified release '$env:YGGDRASIL_VERSION'."
            exit 1
        }
        Write-Host "[Yggdrasil] Notice: No published release found or GitHub API unavailable. Falling back to 'main' branch..."
        $Verified = $true
    } else {
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
}

# --- Phase 2: verified installer (direct flow). -----------------------------
Write-Host "[Yggdrasil] Checking system prerequisites..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is required but not installed. Please install Git: https://git-scm.com/"
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js (>=20.9.0) is required but not installed. Please install Node.js: https://nodejs.org/"
    exit 1
}

# Node >= 20.9.0: parse major.minor and compare numerically.
$nodeVersion = (node --version).TrimStart("v") # e.g. 20.9.0
$nodeParts = $nodeVersion.Split(".")
if ([int]$nodeParts[0] -lt 20 -or ([int]$nodeParts[0] -eq 20 -and [int]$nodeParts[1] -lt 9)) {
    Write-Error "Node.js (>=20.9.0) is required, but found v$nodeVersion. Please update Node.js: https://nodejs.org/"
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
Write-Host "[Yggdrasil] pnpm ready."

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
$appDir = Join-Path $TargetDir "app"
$branchOrTag = if ($env:YGGDRASIL_VERSION) { $env:YGGDRASIL_VERSION } else { "main" }

if (-not (Test-Path (Join-Path $appDir ".git"))) {
    Write-Host "[Yggdrasil] Cloning repository ($branchOrTag) to $appDir..."
    try {
        git clone --depth 1 --single-branch --branch $branchOrTag "https://github.com/$GithubOwnerRepo.git" $appDir
    } catch {
        git clone --depth 1 --branch main "https://github.com/$GithubOwnerRepo.git" $appDir
    }
} else {
    Write-Host "[Yggdrasil] Existing repository detected at $appDir. Fetching updates..."
    try {
        git -C $appDir fetch --depth 1 origin $branchOrTag
        git -C $appDir checkout $branchOrTag
    } catch { }
}

Set-Location $appDir
$env:NODE_OPTIONS = if ($env:NODE_OPTIONS) { $env:NODE_OPTIONS } else { "--max-old-space-size=2048" }
$env:NODE_ENV = "production"

Write-Host "[Yggdrasil] Installing dependencies..."
try {
    pnpm install --frozen-lockfile
} catch {
    pnpm install
}

Write-Host "[Yggdrasil] Building production Next.js application..."
pnpm build

Write-Host "[Yggdrasil] Running CLI installer..."
node bin\yggdrasil.mjs install --dir $TargetDir
