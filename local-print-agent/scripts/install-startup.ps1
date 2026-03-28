$ErrorActionPreference = "Stop"

$startupDir = [Environment]::GetFolderPath('Startup')
if (-not (Test-Path $startupDir)) {
  New-Item -ItemType Directory -Path $startupDir | Out-Null
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentRoot = Resolve-Path (Join-Path $scriptDir "..")
$exePath = Join-Path $agentRoot "dist\xburger-print-agent.exe"
$nodeScript = Join-Path $agentRoot "src\server.js"

if (Test-Path $exePath) {
  $targetPath = $exePath
  $arguments = ""
} else {
  $nodeCmd = (Get-Command node.exe -ErrorAction SilentlyContinue)
  if (-not $nodeCmd) {
    throw "node.exe não encontrado. Gere o EXE com npm run build:exe ou instale Node.js."
  }
  $targetPath = $nodeCmd.Source
  $arguments = "\"$nodeScript\""
}

$linkPath = Join-Path $startupDir "XBurger Print Agent.lnk"
$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($linkPath)
$shortcut.TargetPath = $targetPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $agentRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "XBurger Local Print Agent"
$shortcut.Save()

Write-Host "Atalho de inicialização criado em: $linkPath"
