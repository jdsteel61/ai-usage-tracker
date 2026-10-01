param(
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $DestinationPath) {
  throw "Refusing to overwrite an existing archive: $DestinationPath"
}
Compress-Archive -LiteralPath $SourceDirectory -DestinationPath $DestinationPath -CompressionLevel Optimal
