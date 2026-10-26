# Guarda DB_PASSWORD en apps\api\.env (ignorado por Git) sin mostrarla ni pasarla como argumento.
# Uso (en tu terminal):  .\tools\set-db-password.ps1
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps\api\.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path (Split-Path $envFile) '.env.example') $envFile
}
$secure = Read-Host 'Contrasena de eta15_app' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrEmpty($plain)) { throw 'La contrasena no puede estar vacia.' }
$lines = Get-Content $envFile | Where-Object { $_ -notmatch '^DB_PASSWORD=' }
$lines += "DB_PASSWORD=$plain"
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
$plain = $null
Write-Host "DB_PASSWORD guardada en $envFile (no se muestra)."
