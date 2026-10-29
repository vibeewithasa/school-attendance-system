# ETA 15 — School Operations Platform

A modular school operations platform for **Escuela Secundaria Técnica No. 15** in Costa Rica, Sinaloa, Mexico.

The project focuses on daily attendance, school records, role-based access, and reliable workflows for staff. It is being built iteratively, with security and offline usability as core design considerations.

> **Status:** Active development. Development and demonstration environments use synthetic data only. This project is not presented as production-ready or authorized to process real student records.

## Technology

| Component | Stack |
| --- | --- |
| API | Node.js 24, TypeScript, Fastify, Drizzle ORM |
| Database | PostgreSQL 18 |
| Administrative web app | React, Vite, Tailwind CSS |
| Android app | Kotlin, Jetpack Compose, Room |
| Monorepo | pnpm workspaces |
| Testing | Vitest and project-specific integration tests |

## Current scope

- Account and session management with role-based permissions
- School years, groups, students, and enrollments
- Staff group assignments and scoped access
- Daily attendance capture with server-side validation and auditability
- Android attendance client development, including encrypted local demo data

Planned or not-yet-complete capabilities include production mobile authentication, offline synchronization, absence justifications, and arrival-time tracking. See [project status](docs/architecture/estado-del-proyecto.md) for the authoritative implementation details.

## Repository structure

```text
apps/
  api/                 Fastify API and database integrations
  web-admin/           Administrative web application
  android-prefectura/  Android attendance client
  access-pwa/          Planned access-control client
packages/
  shared-contracts/    Shared API/client contracts
  ui/                  Shared UI package
docs/                  Architecture decisions and project status
tools/                 Development environment and database tooling
```

## Local development

The supported development environment is **native Windows 11 with PowerShell** (no Docker or WSL). You will need Node.js 24, pnpm, and a local PostgreSQL instance. Android tooling is required only for Android development.

```powershell
. .\tools\env.ps1
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run the API and administrative web app in separate terminals:

```powershell
pnpm dev:api
pnpm dev:web
```

Database-backed commands require local credentials stored outside version control. Use the provided example environment files and follow the repository's development documentation. Never commit actual credentials or student records.

For a disposable environment with **fictional data only**, review the documented `pnpm dev:sandbox` workflow.

## Development principles

- Protect student and staff privacy; never use real student data in development, tests, or demonstrations.
- Apply least-privilege database access and explicit role scopes.
- Treat migrations, schema changes, and real-data deployment as separately reviewed operations.
- Validate changes with the project's type checking, linting, and tests.

See [CLAUDE.md](CLAUDE.md) for repository-specific development conventions and [architecture documentation](docs/architecture/) for design decisions.

## Licensing

**No open-source license is currently granted by this repository.** Rights and institutional approvals must be reviewed before any public release or licensing decision.
