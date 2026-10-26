/**
 * Limitador de intentos fallidos EN MEMORIA (ventana fija por clave). Sin dependencias ni almacenamiento externo.
 *
 * Limitaciones (documentadas en docs/architecture/auth-rbac.md):
 *  - El estado vive en el proceso: se pierde al reiniciar y NO se comparte entre instancias. Con mas de una
 *    instancia detras de un balanceador cada una cuenta por separado (el limite efectivo es N veces mayor) y haria
 *    falta un almacen compartido (p. ej. Redis o una tabla), fuera del alcance de esta fase.
 *  - Para acotar la memoria hay un maximo de claves: al llenarse se descartan primero las vencidas y despues las mas
 *    antiguas, de modo que un atacante con muchas claves falsas puede expulsar contadores legitimos (degradacion
 *    controlada; el limite por IP del plugin de rate-limit sigue actuando).
 */
export interface AttemptLimiterOptions {
  /** Fallos permitidos por ventana; al alcanzarlo, la clave queda bloqueada hasta que venza la ventana. */
  max: number;
  windowMs: number;
  maxKeys?: number;
  /** Reloj en milisegundos (inyectable en pruebas). */
  now?: () => number;
}

export interface AttemptLimiter {
  /** Milisegundos que faltan para poder intentar de nuevo; 0 si la clave no esta bloqueada. */
  blockedFor(key: string): number;
  /** Registra un intento fallido. */
  fail(key: string): void;
  /** Olvida la clave (p. ej. tras un inicio de sesion correcto). */
  reset(key: string): void;
  readonly size: number;
}

export function createAttemptLimiter(options: AttemptLimiterOptions): AttemptLimiter {
  const { max, windowMs } = options;
  const maxKeys = options.maxKeys ?? 50_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { count: number; resetAt: number }>();

  function makeRoom(): void {
    const t = now();
    for (const [k, v] of entries) if (v.resetAt <= t) entries.delete(k);
    while (entries.size >= maxKeys) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    blockedFor(key) {
      const e = entries.get(key);
      if (!e) return 0;
      const t = now();
      if (e.resetAt <= t) {
        entries.delete(key);
        return 0;
      }
      return e.count >= max ? e.resetAt - t : 0;
    },
    fail(key) {
      const t = now();
      const e = entries.get(key);
      if (e && e.resetAt > t) {
        e.count += 1;
        return;
      }
      if (!e && entries.size >= maxKeys) makeRoom();
      entries.set(key, { count: 1, resetAt: t + windowMs });
    },
    reset(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}
