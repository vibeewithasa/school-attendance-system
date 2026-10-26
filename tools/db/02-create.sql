-- ETA15: crea rol y base de desarrollo (ejecutar como administrador; aborta ante cualquier error)
\set ON_ERROR_STOP on

-- Guarda previa (solo lectura): aborta antes de escribir si ya existe algo con estos nombres,
-- para no adoptar objetos ajenos ni dejar un estado parcial.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eta15_app') THEN
    RAISE EXCEPTION 'El rol eta15_app ya existe; revisar antes de continuar';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'eta15_dev') THEN
    RAISE EXCEPTION 'La base eta15_dev ya existe; revisar antes de continuar';
  END IF;
END
$guard$;

-- Cada sentencia siguiente corre en su propia transaccion (CREATE DATABASE no admite bloque).
-- Si CREATE DATABASE fallara tras crear el rol, solo quedaria eta15_app (sin login ni privilegios):
-- se retira con  DROP ROLE eta15_app;  y se reejecuta este script.

CREATE ROLE eta15_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

CREATE DATABASE eta15_dev OWNER eta15_app ENCODING 'UTF8' TEMPLATE template0;

-- Solo eta15_app (y administradores) pueden conectarse a esta base
REVOKE ALL ON DATABASE eta15_dev FROM PUBLIC;

SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
FROM pg_roles WHERE rolname = 'eta15_app';
SELECT datname, pg_get_userbyid(datdba) AS owner, pg_encoding_to_char(encoding) AS encoding
FROM pg_database WHERE datname = 'eta15_dev';
