# Push fb-page-manager to GitHub main
# Run in PowerShell from this folder after GitHub login.

$ErrorActionPreference = "Stop"
$git = "C:\Program Files\Git\bin\git.exe"
$repo = $PSScriptRoot

Set-Location $repo

if (-not (Test-Path $git)) {
    Write-Host "Install Git: winget install Git.Git" -ForegroundColor Yellow
    exit 1
}

& $git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) {
    & $git remote add origin https://github.com/Faisalrehman14/fb-page-manager.git
}

$status = & $git status --porcelain
if ($status) {
    & $git add -A
    & $git commit -m "Messenger: auto-sync inbox, can_reply filter, 7-day message retention"
}

Write-Host "Pushing to https://github.com/Faisalrehman14/fb-page-manager (main)..." -ForegroundColor Cyan
Write-Host "GitHub login window may open — sign in as Faisalrehman14" -ForegroundColor Yellow

& $git push -u origin main --force-with-lease

if ($LASTEXITCODE -eq 0) {
    Write-Host "Done! https://github.com/Faisalrehman14/fb-page-manager" -ForegroundColor Green
} else {
    Write-Host "Push failed. Options:" -ForegroundColor Red
    Write-Host "  1. GitHub Desktop: Add local repo -> Publish / Push origin"
    Write-Host "  2. PAT: git remote set-url origin https://YOUR_TOKEN@github.com/Faisalrehman14/fb-page-manager.git"
    Write-Host "  3. SSH: git remote set-url origin git@github.com:Faisalrehman14/fb-page-manager.git"
}
