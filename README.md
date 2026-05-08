# Asura

> Workspace phantom — synthwave dashboard para tus proyectos de desarrollo locales.

![Asura](./assets/asura-prime.svg)

Panel Electron que escanea tu carpeta de proyectos y muestra:

- **Apps** — todos tus repos con stack detectado (Next, FastAPI, Postgres…), git branch, último commit, sparkline 14d, badge de URL prod si está deployado
- **Bots** — progreso live de scrapers/jobs vía SDK ligero (Node/Python)
- **Infra** — contenedores Docker / Podman / WSL en vivo (CPU, RAM, puertos, start/stop/restart)
- **Alerts** — historial: bot crashed, branch stale, proyecto nuevo

## Empezar

Mira [`INSTALL.md`](./INSTALL.md) para instrucciones humanas o [`CLAUDE.md`](./CLAUDE.md) si vas a delegar la instalación a un agente Claude Code.

Resumen:

```bash
npm install
npm start
```

## Stack

- Electron 32 + TypeScript estricto
- Vanilla HTML/CSS/JS (sin frameworks frontend)
- Express HTTP local en `127.0.0.1:27315`
- Detección Docker via shell out a CLI (sin dockerode)

## Config

Tu config personal: `~/.asura/config.json`. Workspace roots, favoritos, ajustes — todo aislado por usuario.

## Licencia

Privado / personal. Compartir libre.
