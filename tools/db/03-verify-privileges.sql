-- ETA15: verificacion de solo lectura de privilegios (ejecutar conectado como eta15_app a eta15_dev)
\pset pager off
SELECT current_user AS usuario, current_database() AS base,
       r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
FROM pg_roles r WHERE r.rolname = current_user;

SELECT pg_get_userbyid(datdba) AS propietario_eta15_dev FROM pg_database WHERE datname = 'eta15_dev';

SELECT datname,
       has_database_privilege(current_user, datname, 'CONNECT') AS connect,
       has_database_privilege(current_user, datname, 'CREATE') AS create_schema,
       has_database_privilege(current_user, datname, 'TEMPORARY') AS temp
FROM pg_database WHERE NOT datistemplate ORDER BY datname;

SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS puede_crear_en_public,
       pg_get_userbyid(nspowner) AS propietario_schema_public
FROM pg_namespace WHERE nspname = 'public';

SELECT count(*) AS tablas_de_usuario
FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');
