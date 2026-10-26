# ADR 0003 — Permisos PUBLIC en PostgreSQL local: riesgo aceptado para desarrollo

- Estado: aceptada (temporal, solo desarrollo local)
- Fecha: 2026-10-26

## Contexto

La verificación de privilegios (`tools/db/03-verify-privileges.sql`) mostró que el rol `eta15_app`:

- no es superusuario y no tiene `CREATEDB`, `CREATEROLE`, `REPLICATION` ni `BYPASSRLS`;
- es propietario de `eta15_dev` y puede crear objetos allí;
- tiene `CONNECT` y `TEMPORARY` sobre `beauty_pos` y `postgres`, heredados del privilegio predeterminado de `PUBLIC` (no se concedieron explícitamente). No tiene `CREATE` en ellas.

## Decisión

No modificar los permisos de `beauty_pos` ni de `postgres`, y no crear scripts de corrección por ahora.
El hallazgo se acepta como riesgo temporal: el servidor solo admite conexiones de loopback (`pg_hba.conf`) y no contiene datos reales de ETA 15.

## Condiciones antes de cualquier despliegue con datos reales

1. Revisar y retirar `CONNECT` a `PUBLIC` en las bases del servidor, o usar una instancia dedicada a ETA 15.
2. Separar roles: el rol de **ejecución de la API** tendrá solo `SELECT/INSERT/UPDATE/DELETE` sobre tablas y uso de secuencias; el rol **propietario del esquema y de migraciones** (p. ej. `eta15_owner`) será distinto y no lo usará la aplicación en tiempo de ejecución.
3. Revisar `listen_addresses` (hoy `'*'`) y las reglas de firewall.
