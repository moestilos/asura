# CLAUDE.md — Instrucciones para Claude Code

> Tu colega te ha pasado este zip. Lee y ejecuta las instrucciones siguientes para dejar Asura instalado y corriendo en su máquina.

## Contexto

Asura es un panel Electron synthwave que escanea su workspace de desarrollo y muestra proyectos + bots + contenedores Docker + alertas. Stack: Electron 32 + TypeScript estricto + vanilla HTML/CSS. No usa frameworks frontend.

Este directorio (`asura/`) debe vivir en `<workspace>/apps/asura/` para que el escáner detecte los proyectos hermanos automáticamente. Si el usuario aún no tiene esa estructura, créala.

## Tarea

Instala Asura y déjala corriendo. Pasos exactos:

### 1. Verifica entorno

```bash
node --version    # debe ser 18+ (idealmente 20+)
npm --version
```

Si Node no está → indica al usuario que descargue desde <https://nodejs.org> antes de continuar. NO intentes instalar Node tú.

### 2. Verifica ubicación

Confirma que estás en `<algo>/apps/asura/`. Si el usuario extrajo en un sitio raro, mueve la carpeta:

```bash
# Estructura ideal:
# C:/dev/apps/asura/         <- aquí
# C:/dev/apps/<sus-proyectos>/   <- el escáner los detectará
```

Si la carpeta padre no se llama `apps`, el escáner igual funciona pero con menos heurística — preferible reorganizar.

### 3. Instala dependencias

```bash
cd <ruta>/apps/asura
npm install
```

Tarda 30-90s. Baja Electron (~80MB) + TypeScript + Express. No interactuar.

### 4. Compila

```bash
npm run build
```

Genera `dist/`. Si hay errores TS reales (no warnings), arréglalos antes de continuar — NO uses `--skipLibCheck` ni `tsc --noEmit false` para enmascararlos.

### 5. Arranca y verifica

```bash
npm start
```

Espera a ver "Asura HTTP server on port 27315" en consola. La ventana flotante debe aparecer abajo a la derecha. Si no aparece:

- Verifica que `assets/asura-pixel.ico` existe (icono tray)
- Si Electron crashea con error de GPU: `npm start -- --disable-gpu`
- En WSL/Linux puede pedir libs: `apt install libnss3 libgbm1 libasound2`

### 6. Crea atajo `asura` global (opcional pero recomendado)

**Windows:** crea `C:\Users\<user>\bin\asura.bat`:

```bat
@echo off
setlocal
set "AS_DIR=<ruta-absoluta>\apps\asura"
curl -s --max-time 1 http://127.0.0.1:27315/ping >nul 2>&1
if %errorlevel% equ 0 (
  curl -s http://127.0.0.1:27315/show >nul 2>&1
  exit /b 0
)
if not exist "%AS_DIR%\dist\main.js" (
  cd /d "%AS_DIR%" && npx tsc
)
start "" /B cmd /c "cd /d "%AS_DIR%" && npx electron ."
```

Asegúrate que `C:\Users\<user>\bin\` está en PATH (revisa con `echo $PATH`). Si no, añádelo via `setx PATH "%PATH%;C:\Users\<user>\bin"`.

**macOS/Linux:** crea `~/.local/bin/asura`:

```sh
#!/bin/sh
AS_DIR="<ruta-absoluta>/apps/asura"
if curl -s --max-time 1 http://127.0.0.1:27315/ping >/dev/null 2>&1; then
  curl -s http://127.0.0.1:27315/show >/dev/null 2>&1
  exit 0
fi
[ ! -f "$AS_DIR/dist/main.js" ] && (cd "$AS_DIR" && npx tsc)
cd "$AS_DIR" && nohup npx electron . >/dev/null 2>&1 &
```

`chmod +x` y verifica `~/.local/bin` está en PATH.

### 7. Configurar workspace roots si los proyectos están en otro sitio

Si los proyectos del usuario NO están en `<dir>/apps/`, edita `~/.asura/config.json` (Windows: `C:\Users\<user>\.asura\config.json`). Si no existe, créalo después del primer arranque:

```json
{
  "workspaceRoots": ["C:/Users/<user>/dev", "D:/repos"],
  "alwaysOnTop": true,
  "theme": "dark"
}
```

Reinicia Asura tras editar.

## Reglas durante la instalación

- **No modifiques** código fuente salvo bug real bloqueante. Si el build falla por algo no reproducible en la máquina del autor, anota el problema y pregunta antes de tocar.
- **No instales** dependencias adicionales fuera de las del `package.json`.
- **No cambies** versiones (`electron`, `typescript`, `express`) sin razón.
- **No commitees** nada — el usuario decide si esto va a su git.
- Si encuentras `.asura/` en home con datos previos: NO sobrescribir. Ya tiene config personal.
- Tray icon es `assets/asura-pixel.ico`. Si Windows reporta icono inválido, regenera con Python+PIL desde `assets/asura-pixel.svg` (16x16 native).

## Validación final

Antes de dar por terminada la instalación:

1. ✅ Ventana abierta, fondo synthwave gradiente animado, sol en horizonte
2. ✅ Tab "Apps" muestra proyectos hermanos (si los hay)
3. ✅ Tab "Infra" muestra contenedores si hay Docker corriendo, o estado "Daemon parado" si no
4. ✅ Tab "Bots" / "Alerts" navegables (probablemente vacíos)
5. ✅ Comando `asura` en terminal funciona si creaste el `.bat`/script
6. ✅ Cerrar con ✕ mata el proceso (verificar con `tasklist | grep electron` Windows o `pgrep electron` Unix)

Reporta al usuario:
- Ruta donde quedó instalado
- Si el atajo `asura` global funciona
- Workspace roots configurados
- Cualquier dependencia opcional faltante (Docker, Python+PIL para regenerar iconos, etc.)

## Personalización futura

El usuario puede pedirte:
- Cambiar paleta (raíz `<style>` en `src/renderer/index.html` — vars `--pink`, `--cyan`, `--sun`, `--violet`)
- Reemplazar logo (`assets/asura-prime.svg` titlebar, `asura-pixel.svg` tray)
- Renombrar a su gusto (cambiar `productName` en `package.json` + `<title>` en HTML + `.brand-name`)
- Añadir nuevos detectores stack en `src/scanner.ts` (vars `STACK_HINTS`, `PY_HINTS`)

Tras cualquier cambio: `npm run build` y reinicio.

## Troubleshooting común

| Problema | Causa | Fix |
|---|---|---|
| `EADDRINUSE 27315` | otra instancia corriendo | `taskkill //F //PID <pid>` o cierra la ventana anterior |
| `Cannot find module 'electron'` | falta `npm install` | `cd apps/asura && npm install` |
| Tray icon vacío | `.ico` corrupto | regenera con PIL desde `assets/asura-pixel.svg` |
| Stack chips no aparecen | proyecto sin `package.json`/`pyproject.toml` | añade uno o ignóralo via context menu → Ocultar |
| Tab Infra siempre vacío | Docker daemon parado | arrancar Docker Desktop / `podman machine start` |

---

## Resumen para el usuario tras terminar

Cuando hayas instalado y verificado, escribe al usuario un resumen:

```
✅ Asura instalado en <ruta>
✅ Lanzar con: npm start (o asura desde terminal)
✅ Config personal en ~/.asura/config.json
✅ Workspace escaneado: <root1>, <root2>...
✅ Docker detectado: SÍ/NO
```

Listo. Cualquier customización después se hace editando archivos directamente y reconstruyendo.
