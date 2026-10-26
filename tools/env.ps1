# Activa el entorno de ETA 15 en la sesión actual de PowerShell (no modifica nada global).
# Uso:  . C:\Projects\ETA15\tools\env.ps1
$root = Split-Path $PSScriptRoot -Parent
$major = (Get-Content (Join-Path $root '.node-version') -Raw).Trim().TrimStart('v').Split('.')[0]

# Node: fnm guarda las versiones en %APPDATA%\fnm\node-versions
$versions = Join-Path $env:APPDATA 'fnm\node-versions'
$match = Get-ChildItem $versions -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "v$major.*" } |
    Sort-Object { [version]($_.Name.TrimStart('v')) } -Descending | Select-Object -First 1
if (-not $match) { throw "Node $major no esta instalado en fnm. Ejecuta: fnm install $major" }
$env:PATH = "$($match.FullName)\installation;$env:PATH"

# Android (solo esta sesion)
$env:ANDROID_HOME     = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME        = 'C:\Program Files\Android\Android Studio\jbr'
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

# PostgreSQL client (solo esta sesion)
$env:PATH = "C:\Program Files\PostgreSQL\18\bin;$env:PATH"

"ETA15 env -> node $(node -v) | java $((java -version 2>&1 | Select-Object -First 1))"
