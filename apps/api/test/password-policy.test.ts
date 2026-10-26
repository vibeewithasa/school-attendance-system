import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  activationCodeFromHash,
  normalizeActivationCode,
  passwordLength,
  validateNewPassword,
} from '@eta15/shared-contracts';

/** Politica inicial de contrasenas y codigo de verificacion de la activacion (codigo puro de shared-contracts). */
const reasons = (password: string, ctx = {}) => {
  const r = validateNewPassword(password, ctx);
  return r.ok ? [] : r.reasons;
};

describe('politica de contrasenas', () => {
  it('limites: minimo 12 y maximo 128 caracteres Unicode (no bytes)', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(reasons('Corta 1')).toEqual(['too_short']);
    expect(reasons('una frase de doce')).toEqual([]);
    expect(reasons('vaca luna mesa ' + 'x'.repeat(114))).toContain('too_long');
    expect(reasons('ñ'.repeat(11) + 'a b')).toEqual([]); // 14 caracteres aunque ocupen mas bytes
    expect(passwordLength('🌙'.repeat(12))).toBe(12); // un emoji cuenta como un caracter
    expect(reasons('🌙'.repeat(12) + '!')).toEqual([]);
  });

  it('acepta frases largas sin reglas de composicion (sin mayusculas, numeros ni simbolos obligatorios)', () => {
    for (const p of [
      'el gato duerme sobre la mesa azul',
      'mi abuela cocina frijoles los domingos',
      'cielo nublado en costa rica sinaloa',
    ]) {
      expect(validateNewPassword(p).ok, p).toBe(true);
    }
  });

  it('rechaza contrasenas comunes y palabras comunes con relleno de digitos o simbolos', () => {
    for (const p of [
      '123456789012',
      'qwertyuiopas',
      'Password123456',
      'contraseña123456',
      'Contrasena2026!!!!',
      'administrador',
      'Secundaria2026!!',
      'ETA15eta15eta15',
      'bienvenido1234',
    ]) {
      expect(reasons(p), p).toContain('common');
    }
  });

  it('compara tras NFKC y sin acentos (la misma contrasena escrita de otra forma sigue siendo comun)', () => {
    expect(reasons('ＰＡＳＳＷＯＲＤ１２３４５６')).toContain('common'); // ancho completo
    expect(reasons('Contraseña2026!!!!'.normalize('NFD'))).toContain('common');
  });

  it('rechaza repeticiones, secuencias y el correo o el nombre de la persona', () => {
    expect(reasons('aaaaaaaaaaaaaa')).toContain('repetitive');
    expect(reasons('abcabcabcabcabc')).toContain('repetitive');
    expect(reasons('🌙'.repeat(12))).toContain('repetitive');
    expect(reasons('🌙🌟🔥🌈🍀🎈🎵🌸🐱🐶🚀⭐')).toEqual([]); // solo emojis distintos: valido
    expect(reasons('abcdefghijklmno')).toContain('sequence');
    expect(reasons('987654321098765')).toContain('sequence');
    expect(reasons('maria.lopez2026abc', { email: 'maria.lopez@escuela.mx' })).toContain(
      'contains_identity',
    );
    expect(reasons('juanperezgarcia123', { displayName: 'Juan Pérez García' })).toContain(
      'contains_identity',
    );
    expect(
      reasons('una frase que no menciona a nadie', {
        email: 'maria.lopez@escuela.mx',
        displayName: 'Juan Pérez',
      }),
    ).toEqual([]);
  });

  it('nunca incluye la contrasena en el resultado', () => {
    const secret = 'Password123456-NO-REPETIR';
    expect(JSON.stringify(validateNewPassword(secret + 'x'.repeat(200)))).not.toContain(
      'NO-REPETIR',
    );
  });
});

describe('codigo de verificacion de la activacion', () => {
  const hash = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);

  it('es determinista, de 10 caracteres Crockford con guion, y depende del hash', () => {
    const code = activationCodeFromHash(hash);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(activationCodeFromHash(hash)).toBe(code);
    expect(activationCodeFromHash(hash.map((b) => b ^ 1))).not.toBe(code);
  });

  it('el vector conocido coincide (guarda contra cambios involuntarios del algoritmo)', () => {
    expect(activationCodeFromHash(new Uint8Array(32))).toBe('00000-00000');
    expect(activationCodeFromHash(new Uint8Array(32).fill(255))).toBe('ZZZZZ-ZZZZZ');
  });

  it('normaliza lo tecleado: mayusculas, espacios, guiones y las letras confundibles I, L, O', () => {
    const code = activationCodeFromHash(hash);
    expect(normalizeActivationCode(code.toLowerCase())).toBe(code);
    expect(normalizeActivationCode(code.replace('-', ' '))).toBe(code);
    expect(normalizeActivationCode(code.replace('-', ''))).toBe(code);
    expect(normalizeActivationCode('ABCDI-L0O12')).toBe('ABCD1-1001' + '2');
  });
});
