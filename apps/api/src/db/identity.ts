/**
 * Identidad de la conexion a PostgreSQL. La API debe usar un rol de EJECUCION (minimo privilegio, no propietario);
 * las migraciones y herramientas de consola, el PROPIETARIO. Ninguna consulta de aqui toca datos.
 */

export const API_ROLE_NAME = 'eta15_api';

/** Solo catalogos: devuelve las banderas de privilegio del rol actual en la base actual. */
export const IDENTITY_SQL = `
  select current_user::text as usuario,
         r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
         pg_has_role(current_user, d.datdba, 'USAGE')          as es_dueno_bd,
         has_schema_privilege(current_user, 'public', 'CREATE') as crea_en_public,
         has_database_privilege(current_user, d.datname, 'CREATE')    as crea_esquemas,
         has_database_privilege(current_user, d.datname, 'TEMPORARY') as crea_temporales
    from pg_roles r, pg_database d
   where r.rolname = current_user and d.datname = current_database()`;

export interface IdentityRow {
  usuario: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  es_dueno_bd: boolean;
  crea_en_public: boolean;
  crea_esquemas: boolean;
  crea_temporales: boolean;
}

/** Problemas de un rol de EJECUCION de la API (vacio = correcto). */
export function runtimeIdentityProblems(row: IdentityRow): string[] {
  const problems: string[] = [];
  if (row.usuario !== API_ROLE_NAME)
    problems.push(`el rol de la API debe ser ${API_ROLE_NAME} y es ${row.usuario}`);
  if (row.rolsuper) problems.push('es superusuario');
  if (row.rolcreaterole) problems.push('puede crear roles');
  if (row.rolcreatedb) problems.push('puede crear bases de datos');
  if (row.rolreplication) problems.push('tiene REPLICATION');
  if (row.rolbypassrls) problems.push('omite la seguridad por filas');
  if (row.es_dueno_bd)
    problems.push('es propietario (o miembro del propietario) de la base: es el rol del migrador');
  if (row.crea_en_public) problems.push('puede crear objetos en el esquema public');
  if (row.crea_esquemas) problems.push('puede crear esquemas');
  if (row.crea_temporales) problems.push('puede crear objetos temporales');
  return problems;
}

/** Problemas de un rol de MIGRACIONES/ADMINISTRACION (vacio = correcto): debe ser el propietario y no la API. */
export function ownerIdentityProblems(row: IdentityRow): string[] {
  const problems: string[] = [];
  if (row.usuario === API_ROLE_NAME)
    problems.push(`las migraciones no pueden usar ${API_ROLE_NAME}`);
  if (!row.es_dueno_bd) problems.push(`${row.usuario} no es propietario de la base`);
  return problems;
}
