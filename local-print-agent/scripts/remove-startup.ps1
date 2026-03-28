$startupDir = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startupDir "XBurger Print Agent.lnk"

if (Test-Path $linkPath) {
  Remove-Item $linkPath -Force
  Write-Host "Atalho removido: $linkPath"
} else {
  Write-Host "Nenhum atalho encontrado em: $linkPath"
}
