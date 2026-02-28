# Build the CamBot-Agent agent container image
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$ImageName = "cambot-agent-agent"
$Tag = if ($args[0]) { $args[0] } else { "latest" }

# Verify Docker is available
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "docker not found in PATH. Make sure Docker Desktop is running."
    exit 1
}

Write-Host "Building CamBot-Agent agent container image..."
Write-Host "Image: ${ImageName}:${Tag}"

# Copy cambot-agents into build context (Dockerfile COPY needs it local)
$AgentsSrc = Join-Path $ScriptDir "..\..\cambot-agents"
$AgentsDst = Join-Path $ScriptDir "cambot-agents"
if (Test-Path $AgentsSrc) {
    Write-Host "Copying cambot-agents into build context..."
    if (Test-Path $AgentsDst) { Remove-Item -Recurse -Force $AgentsDst }
    New-Item -ItemType Directory -Path $AgentsDst | Out-Null
    Copy-Item -Recurse (Join-Path $AgentsSrc "src") (Join-Path $AgentsDst "src")
    Copy-Item (Join-Path $AgentsSrc "package.json") $AgentsDst
    Copy-Item (Join-Path $AgentsSrc "tsconfig.json") $AgentsDst
}

docker build -t "${ImageName}:${Tag}" .

# Clean up copied cambot-agents from build context
if (Test-Path $AgentsDst) { Remove-Item -Recurse -Force $AgentsDst }

Write-Host ""
Write-Host "Build complete!"
Write-Host "Image: ${ImageName}:${Tag}"
