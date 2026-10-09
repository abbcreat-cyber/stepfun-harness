param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $root -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is required to build the Office wrapper.' }
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$root/soffice.exe" (Join-Path $PSScriptRoot '../tools/office/OfficeLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Office wrapper compilation failed' }
Copy-Item -LiteralPath "$root/soffice.exe" -Destination "$root/libreoffice.exe" -Force
