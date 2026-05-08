# Asura — Instalación rápida

Panel synthwave para tu workspace de desarrollo. Apps + Bots + Infra (contenedores) + Alertas en una ventana flotante.

## Requisitos

- **Node.js 18+** (recomendado 20 LTS) — descarga desde <https://nodejs.org>
- **Windows 10/11**, macOS o Linux
- (Opcional) **Docker Desktop** o **Podman** si quieres usar la pestaña Infra

## Instalación (3 pasos)

```bash
# 1. Crear estructura
mkdir myworkspace
cd myworkspace
mkdir apps
cd apps

# 2. Extrae aquí dentro asura-share.zip
#    Resultado esperado: myworkspace/apps/asura/

# 3. Instalar y arrancar
cd asura
npm install
npm start
```

Tarda ~60s la primera vez (baja Electron). Las siguientes arranca instantáneo.

## ¿Qué hace?

- Auto-escanea `myworkspace/apps/<tus-proyectos>/` cada 30s
- Detecta stack (Next.js / FastAPI / Postgres / etc.), git branch, último commit, sparkline 14 días
- Si hay `package.json.homepage` o URL de Vercel/Netlify/Railway en README → muestra badge prod clickable
- Tab **Infra**: lista contenedores Docker/Podman/WSL en vivo (CPU, RAM, puertos), start/stop/restart
- Tab **Bots**: progreso de scrapers (necesita SDK, opcional)
- Tab **Alerts**: historial eventos (bot crashed, branch stale, proyecto nuevo)

## Configuración personal

Tras primer arranque se crea `~/.asura/config.json` con tus favoritos, ocultos, ajustes. Cada usuario su propia config — no se comparte nada.

Para apuntar a otra carpeta de proyectos (ej. `C:/dev` en lugar de `myworkspace`):

```json
{ "workspaceRoots": ["C:/dev", "D:/repos"] }
```

Reinicia Asura.

## Atajo terminal (opcional)

Crea un `asura.bat` en cualquier dir de tu PATH:

```bat
@echo off
cd /d "C:\ruta\a\myworkspace\apps\asura"
start "" /B cmd /c "npx electron ."
```

Luego escribes `asura` en cualquier terminal y arranca.

## Comandos útiles

```bash
npm start         # arrancar
npm run build     # solo compilar TypeScript
npm run dev       # arrancar con recompilación
```

## Personalización

Todo el look está en `src/renderer/index.html` (CSS inline). Cambia paleta en `:root` al inicio del `<style>`. Recompila con `npm run build`.

Tipografías Audiowide / Rajdhani / Major Mono Display vienen vía Google Fonts CDN.

## Problemas frecuentes

**No se ven proyectos**: asegúrate que están en `myworkspace/apps/<n>/` con un `package.json` o `pyproject.toml` o `.git/` dentro.

**Tab Infra dice "Daemon parado"**: Docker Desktop / Podman no está corriendo. Arráncalo y refresca (auto cada 3s).

**Puerto 27315 ocupado**: ya hay otra instancia de Asura corriendo. Cierra la anterior con ✕.

**Quiero cerrar de verdad**: el botón ✕ ya mata el proceso completo (no minimiza a tray).

## Stack

- Electron 32 + TypeScript
- Sin frameworks frontend (vanilla HTML+CSS+JS, ~3000 líneas)
- Express server local en `127.0.0.1:27315` (solo para `/show` desde scripts externos)
