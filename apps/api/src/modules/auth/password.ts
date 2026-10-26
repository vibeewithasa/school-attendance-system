/**
 * Servicio de contrasenas: Argon2id con `node:crypto` (Node >= 24.7, sin dependencias nativas). No hay criptografia
 * propia: la derivacion es `crypto.argon2`; este modulo solo codifica/decodifica el formato, genera la sal con el
 * CSPRNG del sistema y compara en tiempo constante.
 *
 * Formato almacenado (PHC string, el mismo que usan las librerias Argon2 estandar, asi que migrar a otra no obliga a
 * re-hashear): `$argon2id$v=19$m=<KiB>,t=<pasadas>,p=<paralelismo>$<sal base64>$<etiqueta base64>` (base64 sin relleno).
 * Los parametros viajan DENTRO de cada hash: se pueden endurecer en el futuro y `needsRehash` detecta los obsoletos
 * para re-hashear en el siguiente inicio de sesion correcto. Referencia: OWASP Password Storage Cheat Sheet
 * (minimo m=19 MiB, t=2, p=1; aqui se parte de 64 MiB, t=3, p=1).
 *
 * Los errores llevan solo un codigo y un mensaje fijo: jamas incluyen la contrasena, el hash ni la sal.
 */
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

export interface Argon2idParams {
  /** Memoria en KiB. */
  memoryKiB: number;
  /** Numero de pasadas. */
  passes: number;
  parallelism: number;
  /** Longitud de la etiqueta (hash) en bytes. */
  tagLength: number;
}

/** Parametros iniciales (medidos ~100 ms en el equipo de desarrollo). */
export const DEFAULT_PASSWORD_PARAMS: Argon2idParams = {
  memoryKiB: 64 * 1024,
  passes: 3,
  parallelism: 1,
  tagLength: 32,
};

/** Minimos que este servicio acepta al CREAR hashes (OWASP: m>=19 MiB, t>=2, p>=1). */
export const MIN_PASSWORD_PARAMS = {
  memoryKiB: 19 * 1024,
  passes: 2,
  parallelism: 1,
  tagLength: 16,
};
/** Techos al LEER un hash almacenado: un registro corrupto no debe poder agotar la memoria o la CPU del servidor. */
const MAX_PARSE = { memoryKiB: 1024 * 1024, passes: 10, parallelism: 16, tagLength: 64 };

export const SALT_BYTES = 16;
const MIN_SALT_BYTES = 8;
const MAX_SALT_BYTES = 64;
/** Largo maximo de la contrasena (bytes UTF-8 tras normalizar): evita usar el hash como vector de denegacion de servicio. */
export const MAX_PASSWORD_BYTES = 1024;
const ARGON2_VERSION = 19; // 0x13

export type PasswordErrorCode =
  | 'password_invalid_type'
  | 'password_empty'
  | 'password_too_long'
  | 'invalid_hash_format'
  | 'unsupported_hash'
  | 'invalid_params';

const MESSAGES: Record<PasswordErrorCode, string> = {
  password_invalid_type: 'La contrasena debe ser texto',
  password_empty: 'La contrasena no puede estar vacia',
  password_too_long: `La contrasena supera el maximo de ${MAX_PASSWORD_BYTES} bytes`,
  invalid_hash_format: 'El hash almacenado no tiene un formato valido',
  unsupported_hash: 'El hash almacenado usa un algoritmo, version o parametros no admitidos',
  invalid_params: 'Los parametros de Argon2id no son validos',
};

export class PasswordError extends Error {
  readonly code: PasswordErrorCode;
  constructor(code: PasswordErrorCode) {
    super(MESSAGES[code]);
    this.name = 'PasswordError';
    this.code = code;
  }
}

const b64 = (buf: Uint8Array) => Buffer.from(buf).toString('base64').replace(/=+$/, '');
const B64_RE = /^[A-Za-z0-9+/]+$/;

function fromB64(text: string): Buffer {
  if (!B64_RE.test(text) || text.length % 4 === 1) throw new PasswordError('invalid_hash_format');
  return Buffer.from(text, 'base64');
}

function assertCreatableParams(p: Argon2idParams): void {
  const ok =
    Number.isSafeInteger(p.memoryKiB) &&
    Number.isSafeInteger(p.passes) &&
    Number.isSafeInteger(p.parallelism) &&
    Number.isSafeInteger(p.tagLength) &&
    p.memoryKiB >= MIN_PASSWORD_PARAMS.memoryKiB &&
    p.memoryKiB >= 8 * p.parallelism &&
    p.memoryKiB <= MAX_PARSE.memoryKiB &&
    p.passes >= MIN_PASSWORD_PARAMS.passes &&
    p.passes <= MAX_PARSE.passes &&
    p.parallelism >= MIN_PASSWORD_PARAMS.parallelism &&
    p.parallelism <= MAX_PARSE.parallelism &&
    p.tagLength >= MIN_PASSWORD_PARAMS.tagLength &&
    p.tagLength <= MAX_PARSE.tagLength;
  if (!ok) throw new PasswordError('invalid_params');
}

/** NFKC (recomendacion NIST SP 800-63B): la misma contrasena escrita con otra composicion Unicode da el mismo hash. */
function prepare(password: unknown): Buffer {
  if (typeof password !== 'string') throw new PasswordError('password_invalid_type');
  if (password.length === 0) throw new PasswordError('password_empty');
  // Corte barato antes de normalizar (conservador: acota el trabajo de normalizar entradas gigantes).
  if (password.length > MAX_PASSWORD_BYTES) throw new PasswordError('password_too_long');
  const bytes = Buffer.from(password.normalize('NFKC'), 'utf8');
  if (bytes.length > MAX_PASSWORD_BYTES) throw new PasswordError('password_too_long');
  return bytes;
}

interface ParsedHash {
  params: Argon2idParams;
  salt: Buffer;
  tag: Buffer;
}

export function parsePasswordHash(encoded: unknown): ParsedHash {
  if (typeof encoded !== 'string' || encoded.length > 512)
    throw new PasswordError('invalid_hash_format');
  const parts = encoded.split('$');
  // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, tag]
  if (parts.length !== 6 || parts[0] !== '') throw new PasswordError('invalid_hash_format');
  const [, algorithm, version, paramText, saltText, tagText] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== 'argon2id') throw new PasswordError('unsupported_hash');
  if (version !== `v=${ARGON2_VERSION}`) throw new PasswordError('unsupported_hash');
  const m = /^m=(\d{1,8}),t=(\d{1,3}),p=(\d{1,3})$/.exec(paramText);
  if (!m) throw new PasswordError('invalid_hash_format');
  const salt = fromB64(saltText);
  const tag = fromB64(tagText);
  const params: Argon2idParams = {
    memoryKiB: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: tag.length,
  };
  if (
    salt.length < MIN_SALT_BYTES ||
    salt.length > MAX_SALT_BYTES ||
    tag.length < MIN_PASSWORD_PARAMS.tagLength ||
    tag.length > MAX_PARSE.tagLength ||
    params.passes < 1 ||
    params.passes > MAX_PARSE.passes ||
    params.parallelism < 1 ||
    params.parallelism > MAX_PARSE.parallelism ||
    params.memoryKiB < 8 * params.parallelism ||
    params.memoryKiB > MAX_PARSE.memoryKiB
  ) {
    throw new PasswordError('unsupported_hash');
  }
  return { params, salt, tag };
}

async function derive(passwordBytes: Buffer, salt: Buffer, p: Argon2idParams): Promise<Buffer> {
  const out = await argon2Async('argon2id', {
    message: passwordBytes,
    nonce: salt,
    parallelism: p.parallelism,
    tagLength: p.tagLength,
    memory: p.memoryKiB,
    passes: p.passes,
  });
  return Buffer.from(out);
}

export interface PasswordService {
  hash(password: string): Promise<string>;
  /** `true` si coincide. Lanza `PasswordError` solo si el hash almacenado esta corrupto o no es admitido. */
  verify(storedHash: string, password: string): Promise<boolean>;
  /** `true` si el hash usa parametros distintos o mas debiles que los vigentes: re-hashear tras un inicio correcto. */
  needsRehash(storedHash: string): boolean;
  /**
   * Gasta el mismo tiempo que una verificacion real. Usar cuando el usuario no existe o no tiene contrasena, para que
   * la latencia no revele si la cuenta existe.
   */
  decoyVerify(password: string): Promise<false>;
}

export function createPasswordService(
  options: { params?: Argon2idParams; randomSalt?: (n: number) => Buffer } = {},
): PasswordService {
  const params = options.params ?? DEFAULT_PASSWORD_PARAMS;
  assertCreatableParams(params);
  const newSalt = options.randomSalt ?? ((n: number) => randomBytes(n));
  let decoy: Promise<string> | undefined;

  const service: PasswordService = {
    async hash(password) {
      const bytes = prepare(password);
      const salt = newSalt(SALT_BYTES);
      const tag = await derive(bytes, salt, params);
      return `$argon2id$v=${ARGON2_VERSION}$m=${params.memoryKiB},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
    },

    async verify(storedHash, password) {
      const bytes = prepare(password);
      const parsed = parsePasswordHash(storedHash);
      const candidate = await derive(bytes, parsed.salt, parsed.params);
      return candidate.length === parsed.tag.length && timingSafeEqual(candidate, parsed.tag);
    },

    needsRehash(storedHash) {
      const { params: have } = parsePasswordHash(storedHash);
      return (
        have.memoryKiB !== params.memoryKiB ||
        have.passes !== params.passes ||
        have.parallelism !== params.parallelism ||
        have.tagLength !== params.tagLength
      );
    },

    async decoyVerify(password) {
      decoy ??= service.hash('decoy-password-not-used-by-any-account');
      try {
        await service.verify(await decoy, password);
      } catch (err) {
        // Un password invalido (vacio, demasiado largo) igual debe poder pasar por aqui sin alterar el resultado.
        if (!(err instanceof PasswordError)) throw err;
      }
      return false;
    },
  };
  return service;
}
