import { argon2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSWORD_PARAMS,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_PARAMS,
  PasswordError,
  createPasswordService,
  parsePasswordHash,
  type Argon2idParams,
} from '../src/modules/auth/password.js';

// Contrasenas FICTICIAS, solo para estas pruebas.
const PW = 'correct horse battery staple (ficticia)';
const FAST: Argon2idParams = { memoryKiB: 19 * 1024, passes: 2, parallelism: 1, tagLength: 32 };
const svc = createPasswordService({ params: FAST });

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (err) {
    return err instanceof PasswordError ? err.code : `otro:${String(err)}`;
  }
  return 'no_lanzo';
};

describe('hash y verify', () => {
  it('acepta la contrasena correcta y rechaza la incorrecta', async () => {
    const h = await svc.hash(PW);
    expect(await svc.verify(h, PW)).toBe(true);
    expect(await svc.verify(h, PW + 'x')).toBe(false);
    expect(await svc.verify(h, PW.toUpperCase())).toBe(false);
  });

  it('usa el formato PHC argon2id versionado con los parametros embebidos', async () => {
    const h = await svc.hash(PW);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(parsePasswordHash(h).params).toEqual(FAST);
  });

  it('el hash coincide con una derivacion independiente de node:crypto (no es un formato circular)', async () => {
    const h = await svc.hash(PW);
    const { salt, tag } = parsePasswordHash(h);
    const expected = argon2Sync('argon2id', {
      message: Buffer.from(PW.normalize('NFKC')),
      nonce: salt,
      parallelism: FAST.parallelism,
      tagLength: FAST.tagLength,
      memory: FAST.memoryKiB,
      passes: FAST.passes,
    });
    expect(Buffer.compare(Buffer.from(expected), tag)).toBe(0);
  });

  it('sal independiente por hash: la misma contrasena da hashes y sales distintos', async () => {
    const [a, b, c] = await Promise.all([svc.hash(PW), svc.hash(PW), svc.hash(PW)]);
    expect(new Set([a, b, c]).size).toBe(3);
    const salts = [a, b, c].map((h) => parsePasswordHash(h).salt.toString('hex'));
    expect(new Set(salts).size).toBe(3);
    expect(parsePasswordHash(a).salt.length).toBe(16);
    for (const h of [a, b, c]) expect(await svc.verify(h, PW)).toBe(true);
  });

  it('la sal sale del CSPRNG por defecto y es inyectable solo para pruebas', async () => {
    const fixed = createPasswordService({ params: FAST, randomSalt: () => Buffer.alloc(16, 7) });
    expect(await fixed.hash(PW)).toBe(await fixed.hash(PW));
  });

  it('soporta Unicode y normaliza NFKC (composicion distinta, misma contrasena)', async () => {
    const composed = 'contraseña-\u{1F512}-日本語';
    const decomposed = 'contraseña-\u{1F512}-日本語';
    const h = await svc.hash(composed);
    expect(await svc.verify(h, composed)).toBe(true);
    expect(await svc.verify(h, decomposed)).toBe(true);
    expect(await svc.verify(h, 'contrasena-\u{1F512}-日本語')).toBe(false);
  });

  it('no recorta la contrasena (no hay limite de 72 bytes como en bcrypt)', async () => {
    const long = 'a'.repeat(200);
    const h = await svc.hash(long);
    expect(await svc.verify(h, long)).toBe(true);
    expect(await svc.verify(h, long.slice(0, 72))).toBe(false);
    expect(await svc.verify(h, long + 'b')).toBe(false);
  });

  it('funciona con los parametros por defecto (64 MiB, 3 pasadas, p=1)', async () => {
    const prod = createPasswordService();
    const h = await prod.hash(PW);
    expect(h).toContain('$m=65536,t=3,p=1$');
    expect(await prod.verify(h, PW)).toBe(true);
    expect(prod.needsRehash(h)).toBe(false);
    expect(DEFAULT_PASSWORD_PARAMS).toEqual({
      memoryKiB: 65536,
      passes: 3,
      parallelism: 1,
      tagLength: 32,
    });
  });
});

describe('limites de entrada', () => {
  it('rechaza tipo invalido, vacia y demasiado larga (sin gastar memoria de Argon2)', async () => {
    expect(await codeOf(() => svc.hash(undefined as unknown as string))).toBe(
      'password_invalid_type',
    );
    expect(await codeOf(() => svc.hash(12345 as unknown as string))).toBe('password_invalid_type');
    expect(await codeOf(() => svc.hash(''))).toBe('password_empty');
    expect(await codeOf(() => svc.hash('a'.repeat(MAX_PASSWORD_BYTES + 1)))).toBe(
      'password_too_long',
    );
    // 400 caracteres de 3 bytes (1200 bytes) exceden el limite en bytes aunque no en caracteres
    expect(await codeOf(() => svc.hash('日'.repeat(400)))).toBe('password_too_long');
    expect(await codeOf(() => svc.hash('a'.repeat(MAX_PASSWORD_BYTES)))).toBe('no_lanzo');
    const h = await svc.hash(PW);
    expect(await codeOf(() => svc.verify(h, ''))).toBe('password_empty');
    expect(await codeOf(() => svc.verify(h, 'a'.repeat(5000)))).toBe('password_too_long');
  });

  it('exige parametros no inferiores al minimo de OWASP al crear el servicio', () => {
    const weak = (over: Partial<Argon2idParams>) => () =>
      createPasswordService({ params: { ...FAST, ...over } });
    expect(weak({ memoryKiB: MIN_PASSWORD_PARAMS.memoryKiB - 1 })).toThrow(PasswordError);
    expect(weak({ passes: 1 })).toThrow(PasswordError);
    expect(weak({ parallelism: 0 })).toThrow(PasswordError);
    expect(weak({ tagLength: 8 })).toThrow(PasswordError);
    expect(weak({ memoryKiB: 5_000_000 })).toThrow(PasswordError);
    expect(weak({ passes: 2.5 })).toThrow(PasswordError);
    expect(weak({})).not.toThrow();
  });
});

describe('hash almacenado invalido', () => {
  it.each([
    ['vacio', ''],
    ['sin estructura', 'not-a-hash'],
    ['bcrypt', '$2b$12$abcdefghijklmnopqrstuuvwxyzabcdefghijklmnopqrstuvwxyz0'],
    ['campos de menos', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA'],
    [
      'parametros mal formados',
      '$argon2id$v=19$m=abc,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$' + 'A'.repeat(43),
    ],
    ['base64 invalido', '$argon2id$v=19$m=19456,t=2,p=1$%%%$' + 'A'.repeat(43)],
    ['sal demasiado corta', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$' + 'A'.repeat(43)],
    ['demasiado largo', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$' + 'A'.repeat(600)],
  ])('lanza invalid_hash_format/unsupported_hash: %s', async (_name, bad) => {
    const code = await codeOf(() => svc.verify(bad, PW));
    expect(['invalid_hash_format', 'unsupported_hash']).toContain(code);
    expect(() => svc.needsRehash(bad)).toThrow(PasswordError);
  });

  it('rechaza otros algoritmos y versiones (argon2i/argon2d, v=16)', async () => {
    const h = await svc.hash(PW);
    expect(await codeOf(() => svc.verify(h.replace('argon2id', 'argon2i'), PW))).toBe(
      'unsupported_hash',
    );
    expect(await codeOf(() => svc.verify(h.replace('argon2id', 'argon2d'), PW))).toBe(
      'unsupported_hash',
    );
    expect(await codeOf(() => svc.verify(h.replace('v=19', 'v=16'), PW))).toBe('unsupported_hash');
  });

  it('rechaza parametros absurdos de un registro corrupto sin ejecutar Argon2 (proteccion contra DoS)', async () => {
    const h = await svc.hash(PW);
    const huge = h.replace('m=19456', 'm=99999999').replace('t=2', 't=999');
    expect(await codeOf(() => svc.verify(huge, PW))).toBe('unsupported_hash');
    const hugeMem = h.replace('m=19456', 'm=4000000');
    expect(await codeOf(() => svc.verify(hugeMem, PW))).toBe('unsupported_hash');
    const zeroPasses = h.replace('t=2', 't=0');
    expect(await codeOf(() => svc.verify(zeroPasses, PW))).toBe('unsupported_hash');
  });

  it('un hash alterado simplemente no coincide', async () => {
    const h = await svc.hash(PW);
    const tamperedTag = h.slice(0, -2) + (h.endsWith('AA') ? 'BB' : 'AA');
    expect(await svc.verify(tamperedTag, PW)).toBe(false);
  });
});

describe('actualizacion de parametros (needsRehash)', () => {
  it('detecta hashes con parametros obsoletos o distintos de los vigentes', async () => {
    const old = await svc.hash(PW);
    expect(svc.needsRehash(old)).toBe(false);

    const stronger = createPasswordService({
      params: { ...FAST, memoryKiB: 32 * 1024, passes: 3 },
    });
    expect(stronger.needsRehash(old)).toBe(true); // el hash viejo es mas debil que la politica nueva
    expect(createPasswordService({ params: { ...FAST, passes: 3 } }).needsRehash(old)).toBe(true);
    expect(createPasswordService({ params: { ...FAST, tagLength: 48 } }).needsRehash(old)).toBe(
      true,
    );
  });

  it('flujo de migracion: verificar con el hash viejo y re-hashear con los parametros nuevos', async () => {
    const oldSvc = createPasswordService({ params: FAST });
    const newSvc = createPasswordService({ params: { ...FAST, memoryKiB: 24 * 1024, passes: 3 } });
    const stored = await oldSvc.hash(PW);

    // el servicio nuevo sigue verificando hashes con parametros antiguos (se leen del propio hash)
    expect(await newSvc.verify(stored, PW)).toBe(true);
    expect(newSvc.needsRehash(stored)).toBe(true);

    const upgraded = await newSvc.hash(PW);
    expect(newSvc.needsRehash(upgraded)).toBe(false);
    expect(parsePasswordHash(upgraded).params.memoryKiB).toBe(24 * 1024);
    expect(await newSvc.verify(upgraded, PW)).toBe(true);
    expect(await newSvc.verify(upgraded, 'otra')).toBe(false);
  });
});

describe('sin fuga de secretos', () => {
  it('los errores solo contienen codigo y mensaje fijo, nunca la contrasena ni el hash', async () => {
    const secret = 'ficticia-NO-DEBE-APARECER-' + 'z'.repeat(MAX_PASSWORD_BYTES);
    const h = await svc.hash(PW);
    const cases: Array<() => Promise<unknown>> = [
      () => svc.hash(secret),
      () => svc.verify(secret, PW),
      () => svc.verify(h.replace('argon2id', 'argon2i'), 'ficticia-NO-DEBE-APARECER'),
      () => svc.verify('$argon2id$v=19$m=19456,t=2,p=1$%%%$ficticia-NO-DEBE-APARECER', PW),
    ];
    for (const run of cases) {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PasswordError);
      const dump = JSON.stringify({
        m: (err as Error).message,
        s: (err as Error).stack,
        e: { ...(err as object) },
      });
      expect(dump).not.toContain('NO-DEBE-APARECER');
      expect(dump).not.toContain(h);
      expect(dump).not.toContain('zzzz');
    }
  });

  it('decoyVerify siempre devuelve false y no lanza por contrasenas invalidas', async () => {
    expect(await svc.decoyVerify(PW)).toBe(false);
    expect(await svc.decoyVerify('')).toBe(false);
    expect(await svc.decoyVerify('a'.repeat(5000))).toBe(false);
  });
});
