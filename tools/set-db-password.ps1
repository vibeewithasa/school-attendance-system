# Guarda DB_PASSWORD en un archivo de entorno IGNORADO por Git, sin mostrarla ni pasarla como argumento.
#   .\tools\set-db-password.ps1                  -> apps\api\.env           (rol de EJECUCION de la API: eta15_api)
#   .\tools\set-db-password.ps1 -Target migrator -> apps\api\.env.migrator  (propietario/migrador: eta15_app)
# Si el archivo no existe se crea desde su plantilla (.env.example / .env.migrator.example).
param(
    [ValidateSet('api', 'migrator')]
    [string]$Target = 'api'
)
$apiDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps\api'
if ($Target -eq 'api') { $name = '.env'; $user = 'eta15_api'; $template = '.env.example' }
else { $name = '.env.migrator'; $user = 'eta15_app'; $template = '.env.migrator.example' }
$envFile = Join-Path $apiDir $name
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $apiDir $template) $envFile }

$secure = Read-Host "Contrasena de $user (se guarda en apps\api\$name)" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrEmpty($plain)) { throw 'La contrasena no puede estar vacia.' }
$lines = Get-Content $envFile | Where-Object { $_ -notmatch '^(DB_PASSWORD|DB_USER)=' }
$lines += "DB_USER=$user"
$lines += "DB_PASSWORD=$plain"
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
$plain = $null
Write-Host "DB_USER=$user y DB_PASSWORD guardados en apps\api\$name (la contrasena no se muestra)."
