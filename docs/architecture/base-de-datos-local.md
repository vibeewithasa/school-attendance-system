# Base de datos local y readiness

## Configuración

PostgreSQL 18 local, base `eta15_dev`, rol `eta15_app` (sin privilegios administrativos; ver ADR 0003).
Las variables viven en `apps/api/.env` (ignorado por Git); la plantilla es `apps/api/.env.example`.

| Variable                                   | Defecto                                  | Uso                                         |
| ------------------------------------------ | ---------------------------------------- | ------------------------------------------- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` | 127.0.0.1 / 5432 / eta15_dev / eta15_app | Conexión                                    |
| `DB_PASSWORD`                              | —                                        | Solo en `.env` local. Sin valor por defecto |
| `DB_POOL_MAX`                              | 10                                       | Tamaño máximo del pool                      |
| `DB_CONNECT_TIMEOUT_MS`                    | 3000                                     | Espera máxima para abrir conexión           |
| `DB_STATEMENT_TIMEOUT_MS`                  | 10000                                    | Tiempo máximo por consulta                  |
| `READY_TIMEOUT_MS`                         | 2000                                     | Tiempo máximo de `/ready`                   |

Para guardar la contraseña sin que aparezca en pantalla, historial ni argumentos: `.\tools\set-db-password.ps1`.

## Inicialización de la conexión

`src/db/client.ts` → `createDatabase(env)` crea un `pg.Pool` (perezoso: no conecta hasta la primera consulta) y el cliente Drizzle.
`server.ts` lo inyecta en `buildApp(env, { database })`; al hacer `app.close()` (SIGINT/SIGTERM) se cierra primero HTTP y después el pool.
Los errores del pool se registran solo con su código, nunca con el mensaje.

## `/health` vs `/ready`

|             | `GET /health` (liveness)   | `GET /ready` (readiness)                            |
| ----------- | -------------------------- | --------------------------------------------------- |
| Pregunta    | ¿El proceso HTTP responde? | ¿La API puede usar PostgreSQL ahora?                |
| Consulta BD | No                         | Sí, `SELECT 1` con timeout                          |
| Respuesta   | 200 `{status:"ok",…}`      | 200 `{status:"ready"}` / 503 `{status:"not_ready"}` |
| Detalles    | Uptime y hora              | Ninguno (ni host, usuario, SQL ni stack)            |

En despliegues futuros `/ready` debe restringirse por infraestructura.

## Pruebas

```powershell
pnpm test               # unitarias: BD simulada, sin PostgreSQL
pnpm test:integration   # real: PostgreSQL local, solo lectura; falla si no hay DB_PASSWORD
```
