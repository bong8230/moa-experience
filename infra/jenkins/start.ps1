param([int]$Port = 18080)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:LOCALAPPDATA 'Product-Seeding-Automation\jenkins'
$war = Join-Path $runtime 'jenkins.war'
$java = Get-ChildItem -LiteralPath (Join-Path $runtime 'java') -Filter java.exe -Recurse | Select-Object -First 1 -ExpandProperty FullName
if (!$java -or !(Test-Path -LiteralPath $war)) { throw "Jenkins runtime missing: $runtime" }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port is already in use." }
$jenkinsHome = Join-Path $runtime 'home'
New-Item -ItemType Directory -Force -Path $jenkinsHome | Out-Null
$previousHome = $env:JENKINS_HOME
try {
    $env:JENKINS_HOME = $jenkinsHome
    $process = Start-Process -FilePath $java -ArgumentList @('-Xms256m', '-Xmx1024m', '-jar', ('"' + $war + '"'), '--httpListenAddress=127.0.0.1', "--httpPort=$Port") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'stdout.log') -RedirectStandardError (Join-Path $runtime 'stderr.log')
    Set-Content -LiteralPath (Join-Path $runtime 'jenkins.pid') -Value $process.Id -Encoding ASCII
    Write-Output "Jenkins started: PID $($process.Id), http://127.0.0.1:$Port/"
    Write-Output "Initial setup password file: $jenkinsHome\secrets\initialAdminPassword"
} finally {
    $env:JENKINS_HOME = $previousHome
}
