# Build the CamBot-Agent agent container image
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$ImageName = "cambot-agent-claude"
$Tag = if ($args[0]) { $args[0] } else { "latest" }

# Verify Docker is available
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "docker not found in PATH. Make sure Docker Desktop is running."
    exit 1
}

Write-Host "Building CamBot-Agent agent container image..."
Write-Host "Image: ${ImageName}:${Tag}"

# Copy cambot-llm into build context (Dockerfile COPY needs it local)
$AgentsSrc = Join-Path $ScriptDir "..\..\cambot-llm"
$AgentsDst = Join-Path $ScriptDir "cambot-llm"
if (Test-Path $AgentsSrc) {
    Write-Host "Copying cambot-llm into build context..."
    if (Test-Path $AgentsDst) { Remove-Item -Recurse -Force $AgentsDst }
    New-Item -ItemType Directory -Path $AgentsDst | Out-Null
    Copy-Item -Recurse (Join-Path $AgentsSrc "src") (Join-Path $AgentsDst "src")
    Copy-Item (Join-Path $AgentsSrc "package.json") $AgentsDst
    Copy-Item (Join-Path $AgentsSrc "tsconfig.json") $AgentsDst
}

# Copy agent-runner into build context (now lives at repo root, not inside container/)
$RunnerSrc = Join-Path $ScriptDir "..\agent-runner"
$RunnerDst = Join-Path $ScriptDir "cambot-agent-runner"
if (Test-Path $RunnerSrc) {
    Write-Host "Copying agent-runner into build context..."
    if (Test-Path $RunnerDst) { Remove-Item -Recurse -Force $RunnerDst }
    New-Item -ItemType Directory -Path $RunnerDst | Out-Null
    Copy-Item -Recurse (Join-Path $RunnerSrc "src") (Join-Path $RunnerDst "src")
    Get-ChildItem -Recurse -Path (Join-Path $RunnerDst "src") -Filter "*.test.ts" | Remove-Item -Force
    Copy-Item (Join-Path $RunnerSrc "package.json") $RunnerDst
    Copy-Item (Join-Path $RunnerSrc "tsconfig.json") $RunnerDst
}

docker build -t "${ImageName}:${Tag}" .

# Clean up copied sources from build context
if (Test-Path $AgentsDst) { Remove-Item -Recurse -Force $AgentsDst }
if (Test-Path $RunnerDst) { Remove-Item -Recurse -Force $RunnerDst }

Write-Host ""
Write-Host "Build complete!"
Write-Host "Image: ${ImageName}:${Tag}"
