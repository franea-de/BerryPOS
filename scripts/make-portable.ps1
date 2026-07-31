# Script para empaquetar BerryPOS local de forma portátil
$sourceDir = "C:\Users\Gio2026\.gemini\antigravity\scratch\BerryPOS\BerryPOS"
$outputDir = Join-Path $sourceDir "BerryPOS_Portatil"

Write-Host "Creando directorio portátil en: $outputDir" -ForegroundColor Cyan
if (Test-Path $outputDir) {
    Remove-Item -Recurse -Force $outputDir
}
New-Item -ItemType Directory -Path $outputDir | Out-Null

# 1. Copiar Ejecutable Tauri, .env y package.json
Write-Host "Copiando ejecutable de Windows y configuración..." -ForegroundColor Green
Copy-Item (Join-Path $sourceDir "apps\pos\src-tauri\target\release\berrypos.exe") $outputDir
Copy-Item (Join-Path $sourceDir "apps\pos\src-tauri\target\release\.env") $outputDir
Copy-Item (Join-Path $sourceDir "apps\pos\package.json") $outputDir

# 2. Copiar Servidor Backend
Write-Host "Copiando servidor backend..." -ForegroundColor Green
New-Item -ItemType Directory -Path (Join-Path $outputDir "dist-server") | Out-Null
Copy-Item -Recurse (Join-Path $sourceDir "apps\pos\dist-server\*") (Join-Path $outputDir "dist-server")

# 3. Copiar Frontend UI
Write-Host "Copiando frontend UI..." -ForegroundColor Green
New-Item -ItemType Directory -Path (Join-Path $outputDir "dist") | Out-Null
Copy-Item -Recurse (Join-Path $sourceDir "apps\pos\dist\*") (Join-Path $outputDir "dist")

# 4. Copiar Node Modules locales de apps/pos (incluye better-sqlite3)
Write-Host "Copiando dependencias nativas de base de datos..." -ForegroundColor Green
New-Item -ItemType Directory -Path (Join-Path $outputDir "node_modules") | Out-Null
Copy-Item -Recurse (Join-Path $sourceDir "apps\pos\node_modules\*") (Join-Path $outputDir "node_modules")

Write-Host "`n¡Empaquetado completado con éxito! Carpeta lista en: $outputDir" -ForegroundColor Yellow
Write-Host "Puedes copiar esta carpeta a una memoria USB y llevarla a cualquier otra PC con Windows." -ForegroundColor Green
