# ETA 15

Plataforma escolar de la Escuela Secundaria Técnica No. 15 (Costa Rica, Sinaloa).
Monolito modular en un monorepo pnpm. Desarrollo en Windows 11 nativo (sin WSL ni Docker).

## Requisitos

- Windows 11 + PowerShell
- Node.js 24 LTS (ver `.node-version`; se gestiona con fnm)
- pnpm 12.15.0 (vía Corepack, fijado en `package.json`)
- PostgreSQL 18 local (base `eta15_dev`, rol `eta15_app`)

## Inicio rápido

```powershell
. .\tools\env.ps1                      # activa Node 24 y rutas de Android/psql en esta sesión
pnpm install
Copy-Item apps\api\.env.example apps\api\.env   # luego escribe DB_PASSWORD solo en tu .env local
pnpm dev:api                           # http://127.0.0.1:3000/health
pnpm dev:web                           # http://127.0.0.1:5173
```

## Estructura

| Ruta                        | Contenido                                     |
| --------------------------- | --------------------------------------------- |
| `apps/api`                  | API Fastify + TypeScript + Drizzle            |
| `apps/web-admin`            | Portal administrativo React + Vite + Tailwind |
| `apps/android-prefectura`   | Reservado (Kotlin + Compose). Aún sin código  |
| `apps/access-pwa`           | Reservado (control de acceso). Aún sin código |
| `packages/shared-contracts` | Tipos compartidos API ↔ clientes              |
| `packages/ui`               | Reservado para componentes compartidos        |
| `docs/`                     | Arquitectura y decisiones (ADR)               |
| `tools/`                    | Scripts de entorno y SQL de preparación local |

## Comandos

| Comando          | Acción                           |
| ---------------- | -------------------------------- |
| `pnpm typecheck` | TypeScript en todos los paquetes |
| `pnpm lint`      | ESLint                           |
| `pnpm test`      | Pruebas (Vitest)                 |
| `pnpm build`     | Compila API y web                |
| `pnpm format`    | Prettier                         |

Más detalle para contribuir (y para asistentes de IA) en [CLAUDE.md](CLAUDE.md).
