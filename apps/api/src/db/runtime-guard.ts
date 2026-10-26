import type { Database } from './client.js';

export type RuntimeCheck =
  | { status: 'ok' }
  | { status: 'unreachable' } // PostgreSQL no responde: no es un error de configuracion (lo cubre /ready)
  | { status: 'privileged'; problems: string[] }; // la API se conecto con un rol que no es de ejecucion

/**
 * La API no debe ejecutarse con las credenciales del propietario/migrador ni con un rol con privilegios de DDL
 * o administrativos. Se comprueba al arrancar; los problemas se devuelven como texto sin datos sensibles.
 */
export async function checkRuntimeRole(database: Database): Promise<RuntimeCheck> {
  if (!database.verifyRuntimeIdentity) return { status: 'ok' };
  try {
    const problems = await database.verifyRuntimeIdentity();
    return problems.length === 0 ? { status: 'ok' } : { status: 'privileged', problems };
  } catch {
    return { status: 'unreachable' };
  }
}
