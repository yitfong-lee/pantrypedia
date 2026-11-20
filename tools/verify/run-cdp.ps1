# Run the app with remote debugging on and wait until the port really answers,
# instead of sleeping a fixed number of seconds. Then hand off to a test script.
#
# Usage:
#   powershell -File tools\verify\run-cdp.ps1 -Port 9390 -Test tools\verify\verify-030.js
param(
    [int]$Port = 9341,
    [Parameter(Mandatory = $true)][string]$Test,
    [string]$Exe = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path "src-tauri\target\release\pantrypedia.exe")
)

# A previous instance holds the WebView2 user-data folder, which makes the new
# one come up with no browser at all (that was the ECONNREFUSED). Clear it out.
& taskkill /F /IM pantrypedia.exe 2>&1 | Out-Null
Start-Sleep -Milliseconds 800

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$proc = Start-Process -FilePath $Exe -PassThru
"started pid $($proc.Id) on port $Port"

$deadline = (Get-Date).AddSeconds(45)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        $ready = $true
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $ready) {
    "DEVTOOLS PORT NEVER OPENED on $Port"
    Get-Process pantrypedia -ErrorAction SilentlyContinue |
        Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize | Out-String
    & taskkill /F /IM pantrypedia.exe 2>&1 | Out-Null
    exit 1
}

"devtools ready after $([int]((Get-Date) - $proc.StartTime).TotalSeconds)s"
node $Test $Port

& taskkill /F /IM pantrypedia.exe 2>&1 | Out-Null
Start-Sleep -Milliseconds 800
