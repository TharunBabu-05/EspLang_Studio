$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolRoot = Join-Path $projectRoot '.tools'
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
$cli = Join-Path $toolRoot 'arduino-cli.exe'
if (-not (Test-Path -LiteralPath $cli)) {
  $archive = Join-Path $toolRoot 'arduino-cli.zip'
  Invoke-WebRequest -Uri 'https://downloads.arduino.cc/arduino-cli/arduino-cli_1.3.1_Windows_64bit.zip' -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot -Force
}
$config = Join-Path $toolRoot 'arduino-cli.yaml'
$dataDir = (Join-Path $toolRoot 'data').Replace('\', '/')
$downloadDir = (Join-Path $toolRoot 'downloads').Replace('\', '/')
$userDir = (Join-Path $toolRoot 'sketchbook').Replace('\', '/')
$cacheDir = (Join-Path $toolRoot 'build-cache').Replace('\', '/')
$configText = @"
board_manager:
  additional_urls:
    - https://espressif.github.io/arduino-esp32/package_esp32_index.json
directories:
  data: '$dataDir'
  downloads: '$downloadDir'
  user: '$userDir'
network:
  connection_timeout: 1800s
build_cache:
  path: '$cacheDir'
"@
[System.IO.File]::WriteAllText($config, $configText)
& $cli --config-file $config core update-index
if ($LASTEXITCODE -ne 0) { throw 'Arduino package index download failed' }
& $cli --config-file $config core install esp32:esp32@3.3.2
if ($LASTEXITCODE -ne 0) { throw 'ESP32 core installation failed' }
& $cli --config-file $config core list
Write-Host 'Workspace-local ESP32 toolchain is ready.'
