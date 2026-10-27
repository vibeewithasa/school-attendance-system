-- eta15:allow-destructive
-- Politica RBAC del catalogo escolar (PROPUESTA TECNICA DEL MVP, pendiente de ratificacion institucional).
-- Escrita a mano; NO aplicar en eta15_dev sin autorizacion (ver docs/architecture/modelo-catalogo-escolar.md).
--
-- Por que una migracion y no un cambio de codigo: `catalog:manage` esta sembrado con dominio `technical`, el dominio de un
-- permiso es inmutable (permissions_guard) y role_permissions solo admite combinaciones rol/permiso del mismo dominio o
-- `shared` (FK compuestas + CHECK de 0003). Un rol escolar (direccion) NO puede recibirlo, y no se relajan esas guardas.
-- La solucion correcta del modelo es un permiso NUEVO del dominio escolar.
--
-- Cambios (todos sobre datos de configuracion; no hay usuarios ni sesiones; no se tocan 0000-0005):
--   1. Permiso nuevo `catalog:manage_school` (dominio school, NO es de autoridad), concedido a `direccion` (alcance all).
--   2. `admin_tecnico` deja de administrar el catalogo escolar (se le quita `catalog:manage`). Conserva `catalog:read`.
--      El permiso `catalog:manage` queda definido y SIN asignar (reservado); retirarlo es una limpieza futura opcional.
--   3. `prefectura`, `trabajo_social` y `control_acceso` pierden `catalog:read` global: su acceso se concedera cuando exista
--      el requerimiento funcional (prefectura, con alcance assigned_groups ya aplicado). Hoy no hay datos escolares protegidos.
-- Las altas y bajas de role_permissions quedan auditadas por el trigger role_permissions_audit (evento
-- role.permissions_changed). Las DELETE llevan la marca de arriba porque el envoltorio protegido las trata como destructivas;
-- son bajas de asignaciones, reversibles con una nueva migracion.

INSERT INTO "permissions" ("key", "description", "domain", "is_authority") VALUES
  ('catalog:manage_school', 'Crear y modificar ciclos escolares y grupos (dominio escolar)', 'school', false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "role_domain", "permission_id", "permission_domain", "scope")
SELECT r."id", r."domain", p."id", p."domain", 'all'
FROM "roles" r, "permissions" p
WHERE r."key" = 'direccion' AND p."key" = 'catalog:manage_school'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  AND r."key" = 'admin_tecnico' AND p."key" = 'catalog:manage';--> statement-breakpoint

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  AND r."key" IN ('prefectura', 'trabajo_social', 'control_acceso') AND p."key" = 'catalog:read';--> statement-breakpoint

-- Verificacion final: si el resultado no es el esperado, la migracion completa se revierte.
DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" = 'catalog:manage_school' AND rp."scope" = 'all' AND r."key" = 'direccion';
  IF v_n <> 1 THEN RAISE EXCEPTION '0006: direccion debe tener catalog:manage_school (all)'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" IN ('catalog:manage', 'catalog:manage_school')
     AND rp."role_id" NOT IN (SELECT "id" FROM "roles" WHERE "key" = 'direccion');
  IF v_n <> 0 THEN RAISE EXCEPTION '0006: solo direccion administra el catalogo'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" = 'catalog:read' AND r."key" IN ('direccion', 'admin_tecnico');
  IF v_n <> 2 THEN RAISE EXCEPTION '0006: direccion y admin_tecnico conservan catalog:read'; END IF;
END
$$;
