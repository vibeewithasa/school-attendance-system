\quit
-- ========================================================================================================
-- PROPUESTA (NO APLICADA): reducir eta15_api a SOLO LECTURA sobre role_permissions.
-- La linea 1 (\quit) impide ejecutarla completa con psql -f. Requiere autorizacion explicita antes de aplicarse.
-- Detalle y razonamiento: docs/architecture/roles-postgresql.md (seccion 5).
--
-- POR QUE: hoy eta15_api tiene INSERT y DELETE sobre role_permissions. El trigger role_permissions_guard impide
-- conceder o quitar permisos de AUTORIDAD (is_authority) y respeta los dominios school/technical, pero una API
-- comprometida podria anadir o quitar permisos ORDINARIOS a un rol dentro de esos limites (queda en audit_events,
-- con atribucion solo si la aplicacion declara eta15.actor_id).
--
-- POR QUE ES SEGURO REDUCIRLO: ningun codigo de apps/api/src escribe en role_permissions; el inicio/verificacion
-- de sesiones, la creacion de usuarios y la asignacion de roles NO necesitan escribirla. Solo la futura
-- administracion de roles lo haria; hasta entonces los cambios de permisos se hacen por migracion (eta15_app).
--
-- ALCANCE: una tabla de eta15_dev. Nada destructivo (REVOKE de privilegios, sin DROP/TRUNCATE/DELETE de datos).
-- No toca beauty_pos ni postgres. Ejecutar como eta15_app (propietario) conectado a eta15_dev.
-- ========================================================================================================

REVOKE INSERT, DELETE ON role_permissions FROM eta15_api;
-- Verificacion esperada: solo SELECT
--   select string_agg(p, ',') from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
--    where has_table_privilege('eta15_api', 'role_permissions', p);

-- Reversion (cuando exista el endpoint de administracion de roles con revision de seguridad propia):
--   GRANT INSERT, DELETE ON role_permissions TO eta15_api;
