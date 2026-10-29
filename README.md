# ETA 15 — School Attendance System

A school administration platform for **Escuela Secundaria Técnica No. 15** in Costa Rica, Sinaloa, Mexico. The project uses a modular monorepo with a Fastify backend, an administrative web application, and planned attendance and access-control clients.

This repository is developed on **native Windows 11**, without WSL or Docker.

## Requirements

- Windows 11 and PowerShell
- Node.js 24 LTS (see `.node-version`; managed locally through `fnm`)
- pnpm 12.15.0 through Corepack (pinned in `package.json`)
- Local PostgreSQL 18
- A locally configured development database and application/migration roles

## Quick start

From the repository root, run in PowerShell:

```powershell
. .\tools\env.ps1
pnpm install
Copy-Item apps\api\.env.example apps\api\.env
```

Configure database credentials **locally** using the repository's helper scripts. Do not commit `.env` files.

```powershell
.\tools\set-db-password.ps1
.\tools\set-db-password.ps1 -Target migrator
pnpm db:whoami
```

The two password commands configure the API's runtime database role and the separate migration role. The identity check helps verify which account is being used for each connection.

Start the API and administrative web app in separate terminal sessions:

```powershell
pnpm dev:api
pnpm dev:web
```

Local development endpoints:

- API health check: `http://127.0.0.1:3000/health`
- API readiness check: `http://127.0.0.1:3000/ready`
- Administrative web application: `http://127.0.0.1:5173`

## Monorepo structure

| Path | Responsibility |
| --- | --- |
| `apps/api` | Fastify API, TypeScript, Drizzle ORM, PostgreSQL |
| `apps/web-admin` | React, Vite, Tailwind CSS administrative portal |
| `apps/android-prefectura` | Reserved for the Kotlin / Jetpack Compose attendance app |
| `apps/access-pwa` | Reserved for the access-control PWA |
| `packages/shared-contracts` | Types shared between the API and client applications |
| `packages/ui` | Reserved for shared UI components |
| `docs/` | Architecture notes and architecture decision records (ADRs) |
| `tools/` | Local environment scripts and database setup utilities |

Reserved modules may not yet contain a working application.

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm dev:api` | Run the API locally |
| `pnpm dev:web` | Run the administrative web app locally |
| `pnpm typecheck` | Check TypeScript projects |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run unit tests |
| `pnpm test:integration` | Run PostgreSQL integration tests (requires local credentials) |
| `pnpm build` | Build the API and web applications |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:check` | Check database migration consistency |
| `pnpm db:whoami` | Check database connection identities |
| `pnpm db:migrate` | Apply migrations using the migration role |
| `pnpm format` | Format the codebase with Prettier |
| `pnpm format:check` | Check formatting without writing files |

## Intended capabilities

The system is being designed to support:

- Daily group attendance captured by assigned prefects
- Offline attendance capture and later synchronization
- Absence justifications and administrative review
- Reports by student, group, and date range
- Late-arrival tracking through student ID scanning
- Role-based access for school personnel

**Implementation status varies by module.** The list above describes project goals, not a claim that every workflow is already in production.

## Development and security notes

- Use local development credentials only; do not publish real student records or personal data.
- Keep runtime and migration database permissions separate.
- Review access controls, data handling, and deployment configuration before production use.
- Project-specific architectural and developer instructions are documented in [CLAUDE.md](CLAUDE.md) and `docs/`.

## Project status

Active development. The backend and administrative interface are developed iteratively, while the Android and PWA applications are planned separately.
