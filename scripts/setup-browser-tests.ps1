$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $repository ".venv"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    py -3 -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Could not create $venv" }
}

& $python -m pip install -r (Join-Path $repository "requirements-browser.txt")
if ($LASTEXITCODE -ne 0) { throw "Could not install browser-test requirements" }

Write-Host "Browser tests are ready. Run:"
Write-Host "  $python tests\browser.py --channel brave --headed --repo C:\path\to\romarr"
