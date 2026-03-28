$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentRoot = Resolve-Path (Join-Path $scriptDir "..")
$exePath = Join-Path $agentRoot "dist\xburger-print-agent.exe"
$issPath = Join-Path $agentRoot "installer\XBurgerPrintAgent.iss"

if (-not (Test-Path $exePath)) {
  throw "Executável não encontrado em $exePath. Rode npm run build:exe antes."
}
if (-not (Test-Path $issPath)) {
  throw "Script do instalador não encontrado em $issPath."
}

$possibleIscc = @(
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
  "C:\\Program Files\\Inno Setup 6\\ISCC.exe"
)

$iscc = $possibleIscc | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
  throw "ISCC.exe (Inno Setup) não encontrado. Instale Inno Setup 6 para gerar o instalador."
}

Push-Location $agentRoot
try {
  & $iscc $issPath
} finally {
  Pop-Location
}

Write-Host "Instalador gerado em: $agentRoot\\installer\\dist"
