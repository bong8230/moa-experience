$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:LOCALAPPDATA 'Product-Seeding-Automation\jenkins'
$pidFile = Join-Path $runtime 'jenkins.pid'
if (!(Test-Path -LiteralPath $pidFile)) { Write-Output 'No managed Jenkins PID file.'; exit 0 }
$jenkinsPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$jenkinsPid"
if ($process) {
    $war = Join-Path $runtime 'jenkins.war'
    if (!$process.CommandLine.Contains($war)) { throw 'PID ownership mismatch; process was not stopped.' }
    Stop-Process -Id $jenkinsPid
}
Remove-Item -LiteralPath $pidFile
Write-Output 'Jenkins stopped.'
