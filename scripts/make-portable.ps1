# Script para empaquetar BerryPOS local de forma portátil
$sourceDir = "C:\Users\Gio2026\.gemini\antigravity\scratch\BerryPOS\BerryPOS"
$outputDir = Join-Path $sourceDir "BerryPOS_Portatil"

Write-Host "Creando directorio portátil en: $outputDir" -ForegroundColor Cyan
if (Test-Path $outputDir) {
    Remove-Item -Recurse -Force $outputDir
}
New-Item -ItemType Directory -Path $outputDir | Out-Null

# 1. Copiar Ejecutable Tauri y .env
Write-Host "Copiando ejecutable de Windows y configuración..." -ForegroundColor Green
Copy-Item (Join-Path $sourceDir "apps\pos\src-tauri\target\release\berrypos.exe") $outputDir
Copy-Item (Join-Path $sourceDir "apps\pos\src-tauri\target\release\.env") $outputDir

# Crear un package.json limpio para la versión portátil (sin workspace de pnpm)
Write-Host "Creando package.json limpio..." -ForegroundColor Green
$pkgJson = @{
    name = "berrypos-pos-portable"
    version = "0.1.0"
    private = $true
    type = "module"
    dependencies = @{
        "better-sqlite3" = "12.2.0"
    }
} | ConvertTo-Json -Depth 4
$pkgJson | Out-File -FilePath (Join-Path $outputDir "package.json") -Encoding utf8

# 2. Copiar Servidor Backend
Write-Host "Copiando servidor backend..." -ForegroundColor Green
New-Item -ItemType Directory -Path (Join-Path $outputDir "dist-server") | Out-Null
Copy-Item -Recurse (Join-Path $sourceDir "apps\pos\dist-server\*") (Join-Path $outputDir "dist-server")

# 3. Copiar Frontend UI
Write-Host "Copiando frontend UI..." -ForegroundColor Green
New-Item -ItemType Directory -Path (Join-Path $outputDir "dist") | Out-Null
Copy-Item -Recurse (Join-Path $sourceDir "apps\pos\dist\*") (Join-Path $outputDir "dist")

# Copiar Migraciones de Base de Datos SQLite (Drizzle)
Write-Host "Copiando migraciones de base de datos local..." -ForegroundColor Green
New-Item -ItemType Directory -Path (Join-Path $outputDir "drizzle") | Out-Null
Copy-Item -Recurse (Join-Path $sourceDir "apps\pos\drizzle\*") (Join-Path $outputDir "drizzle")

# 4. Instalar dependencias nativas
Write-Host "Instalando base de datos SQLite nativa en la carpeta portátil..." -ForegroundColor Green
Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm install --prefix `"$outputDir`" --omit=dev" -NoNewWindow -Wait

Write-Host "`n¡Empaquetado completado con éxito! Carpeta lista en: $outputDir" -ForegroundColor Yellow
Write-Host "Puedes copiar esta carpeta a una memoria USB y llevarla a cualquier otra PC con Windows." -ForegroundColor Green
