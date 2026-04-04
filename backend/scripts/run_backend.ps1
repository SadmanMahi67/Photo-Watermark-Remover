$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root "..\.venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    Write-Error "Python interpreter not found at $Python"
}

Push-Location $Root
try {
    & $Python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
}
finally {
    Pop-Location
}
