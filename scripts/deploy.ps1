param(
  [Parameter(Mandatory = $true)]
  [string]$Server,

  [string]$ProjectDir = "~/04_Lark_Operating"
)

$ErrorActionPreference = "Stop"

git status --short
git push

ssh $Server "cd $ProjectDir && bash scripts/server-update.sh"

Write-Host "Deploy finished."