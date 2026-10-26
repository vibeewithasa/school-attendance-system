-- ETA15: verificacion de solo lectura (ejecutar como administrador)
\pset pager off
SELECT version();
SHOW listen_addresses;
SHOW password_encryption;
SHOW port;
SELECT 'rol eta15_app existe' AS check, count(*) FROM pg_roles WHERE rolname = 'eta15_app';
SELECT 'bd eta15_dev existe' AS check, count(*) FROM pg_database WHERE datname = 'eta15_dev';
SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE NOT datistemplate ORDER BY 1;
SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1;
SELECT type, database, user_name, address, auth_method FROM pg_hba_file_rules ORDER BY line_number;
