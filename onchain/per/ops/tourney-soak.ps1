# M11 soak: several full tournaments at once on devnet, driven by the test backend's keeper.
# Each runs `dotnet run -- tourney <players>` (its own fresh players), a minute apart.
# Usage: powershell -File per/ops/tourney-soak.ps1 -Sizes "8,9,16" -Out <folder>
# (Sizes is text: through -File a list arrives as one value; "8,9,16" once became 8916 players.)
param([string]$Sizes = "8,9,16", [string]$Out = "$env:TEMP")
$list = $Sizes -split "[,; ]+" | Where-Object { $_ } | ForEach-Object { [int]$_ }
foreach ($n in $list) { if ($n -lt 2 -or $n -gt 30) { throw "tournament size $n is outside 2..30" } }
$env:POKER_PER_KEYS = "\\wsl.localhost\Ubuntu\home\shara\.config\solana\poker-per"
$harness = Join-Path $PSScriptRoot "..\client-harness"
$procs = @()
$k = 0
foreach ($n in $list) {
    $k++
    $log = Join-Path $Out "soak-$k-$n.log"
    $procs += Start-Process -FilePath "dotnet" -ArgumentList @("run", "--no-build", "--", "tourney", "$n") -WorkingDirectory $harness -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -NoNewWindow
    Start-Sleep -Seconds 60
}
$procs | Wait-Process
$k = 0
foreach ($n in $list) {
    $k++
    $log = Join-Path $Out "soak-$k-$n.log"
    "soak $k ($n players): " + (Get-Content $log -Tail 1)
    Select-String -Path $log -Pattern "^FAIL" | ForEach-Object { "   " + $_.Line }
}
