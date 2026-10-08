param([string]$HarnessHome = $env:HARNESS_HOME)
$ErrorActionPreference = 'Stop'
if (-not $HarnessHome) { $HarnessHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.stepfun-harness' }
$toolRoot = Join-Path ([IO.Path]::GetFullPath($HarnessHome)) 'tools'
$venv = Join-Path $toolRoot 'document-python'
$nodeRoot = Join-Path $toolRoot 'document-node'
New-Item -ItemType Directory -Force $toolRoot, $nodeRoot | Out-Null
if (-not (Test-Path (Join-Path $venv 'Scripts/python.exe'))) {
  & py -3.12 -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 with the Python launcher (py) first.' }
}
& (Join-Path $venv 'Scripts/python.exe') -m pip install -r (Join-Path $PSScriptRoot '../tools/documents/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Python document dependency installation failed.' }
& npm.cmd install --prefix $nodeRoot pptxgenjs@4 docx@9 exceljs@4
if ($LASTEXITCODE -ne 0) { throw 'Node document dependency installation failed.' }
Write-Output "Document tools installed under $toolRoot. Install LibreOffice separately and put soffice on PATH for rendering."
