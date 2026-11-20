# Copy the current installers to the Desktop under friendly names and print
# sizes + hashes, so the file that gets shared can be identified later.
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$bundle = Join-Path $repo "src-tauri\target\release\bundle"
$version = (Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json).version
$nsis = Join-Path $bundle "nsis\PantryPedia_${version}_x64-setup.exe"
$msi = Join-Path $bundle "msi\PantryPedia_${version}_x64_en-US.msi"
$desktop = [Environment]::GetFolderPath("Desktop")

foreach ($f in @($nsis, $msi)) {
    if (-not (Test-Path $f)) { throw "missing: $f" }
}

Copy-Item $nsis (Join-Path $desktop "PantryPedia-Setup.exe") -Force
Copy-Item $msi (Join-Path $desktop "PantryPedia-Setup.msi") -Force

Get-ChildItem (Join-Path $desktop "PantryPedia-Setup.*") | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    "{0}  {1:N2} MB  {2}" -f $_.Name, ($_.Length / 1MB), $hash
}
