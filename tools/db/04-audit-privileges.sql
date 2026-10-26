-- ETA15: auditoria de privilegios de Auth/RBAC (SOLO LECTURA). Ejecutar como un rol que pueda leer el catalogo.
-- Resultado esperado tras separar roles (ver docs/architecture/roles-postgresql.md): las tres consultas sin filas
-- indebidas. Mientras API y propietario sean el mismo rol (eta15_app), aparecera ese rol como propietario.
\pset pager off

\echo '== 1. Funciones del esquema public ejecutables por PUBLIC (debe estar vacio) =='
SELECT p.proname
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');

\echo '== 2. Funciones SECURITY DEFINER o sin search_path fijo (debe estar vacio) =='
SELECT p.proname, p.prosecdef AS security_definer, p.proconfig
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND (p.prosecdef OR NOT coalesce(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false));

\echo '== 3. Roles distintos del propietario con privilegios PELIGROSOS en tablas de public (debe estar vacio) =='
\echo '   TRIGGER permite esquivar las guardas; TRUNCATE y REFERENCES tampoco se conceden a la API.'
SELECT g.grantee, g.table_name, g.privilege_type
  FROM information_schema.role_table_grants g
  JOIN pg_class c ON c.relname = g.table_name AND c.relnamespace = 'public'::regnamespace
 WHERE g.table_schema = 'public'
   AND g.privilege_type IN ('TRIGGER', 'TRUNCATE', 'REFERENCES')
   AND g.grantee <> pg_get_userbyid(c.relowner)
 ORDER BY 1, 2, 3;

\echo '== 4. Propietario de tablas y funciones =='
SELECT 'tabla' AS tipo, c.relname AS objeto, pg_get_userbyid(c.relowner) AS propietario
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
UNION ALL
SELECT 'funcion', p.proname, pg_get_userbyid(p.proowner)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
 ORDER BY 1, 2;

\echo '== 5. Privilegios EXECUTE explicitos sobre funciones (solo los 3 ayudantes auth_* para el rol de la API) =='
SELECT p.proname, pg_get_userbyid(a.grantee) AS rol, a.privilege_type
  FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 WHERE p.pronamespace = 'public'::regnamespace AND a.grantee <> p.proowner
 ORDER BY 1, 2;
