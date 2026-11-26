# Run every verification suite against the release binary, on a fresh database.
# Call from anywhere: paths are relative to this script's folder.
$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
$rel = Join-Path (Resolve-Path (Join-Path $here "..\..")).Path "src-tauri\target\release\pantrypedia.exe"

if (-not (Test-Path $rel)) { throw "no release binary at $rel" }

# A running instance holds pantry.db open, so the wipe below would fail
# silently and the "empty pantry" checks would start with ticks in place.
& taskkill /F /IM pantrypedia.exe 2>&1 | Out-Null
Start-Sleep -Milliseconds 800

Remove-Item "$env:APPDATA\com.yitfong.pantrypedia" -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path "$env:APPDATA\com.yitfong.pantrypedia") { throw "could not wipe the test database" }

$suites = @(
    @{ Port = 9390; Test = "verify-030.js";      Name = "catalog, aliases, browse view" },
    @{ Port = 9391; Test = "verify-qr-link.js";  Name = "phone QR link" },
    @{ Port = 9392; Test = "verify-ui-033.js";   Name = "start panel, view all, foldable groups" },
    @{ Port = 9393; Test = "verify-ui-034.js";   Name = "add-missing beside the missing chips" },
    @{ Port = 9394; Test = "verify-clear-all.js"; Name = "Clear all" },
    @{ Port = 9395; Test = "verify-aliases-ms.js"; Name = "Malay aliases" }
)

foreach ($suite in $suites) {
    "=== $($suite.Name) ==="
    powershell -NoProfile -ExecutionPolicy Bypass -File "$here\run-cdp.ps1" `
        -Port $suite.Port -Test "$here\$($suite.Test)" -Exe $rel
}

"=== cleanup: wipe test database ==="
Remove-Item "$env:APPDATA\com.yitfong.pantrypedia" -Recurse -Force -ErrorAction SilentlyContinue
"appdata present: $(Test-Path "$env:APPDATA\com.yitfong.pantrypedia")"
