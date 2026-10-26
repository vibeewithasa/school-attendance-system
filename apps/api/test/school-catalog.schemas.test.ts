import { describe, expect, it } from 'vitest';
import {
  groupInput,
  normalizeGroupCode,
  schoolYearInput,
} from '../src/modules/school-catalog/school-catalog.schemas.js';

const validYear = { name: '2025-2026', startsOn: '2025-08-25', endsOn: '2026-07-15' };

describe('schoolYearInput', () => {
  it('acepta un ciclo valido', () => {
    expect(schoolYearInput.safeParse(validYear).success).toBe(true);
  });
  it.each([
    ['fin igual al inicio', { ...validYear, endsOn: '2025-08-25' }],
    ['fin anterior al inicio', { ...validYear, endsOn: '2025-01-01' }],
    ['fecha inexistente', { ...validYear, startsOn: '2025-02-30' }],
    ['formato no ISO', { ...validYear, startsOn: '25/08/2025' }],
    ['nombre vacio', { ...validYear, name: '' }],
    ['nombre con espacios en los bordes', { ...validYear, name: ' 2025-2026 ' }],
  ])('rechaza %s', (_label, input) => {
    expect(schoolYearInput.safeParse(input).success).toBe(false);
  });
});

describe('normalizeGroupCode', () => {
  it.each([
    ['a', 'A'],
    ['  b  ', 'B'],
    ['1  a', '1 A'],
    ['tec-1', 'TEC-1'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeGroupCode(raw)).toBe(expected);
  });
});

describe('groupInput', () => {
  const base = { schoolYearId: '0199c1a2-7b3e-7c4d-8e5f-0123456789ab', grade: 1, code: 'A' };

  it('acepta un grupo sin turno y usa null por defecto', () => {
    expect(groupInput.parse(base).shift).toBeNull();
  });
  it('normaliza el identificador antes de validar', () => {
    expect(groupInput.parse({ ...base, code: '  tec  1 ' }).code).toBe('TEC 1');
  });
  it('acepta hasta 10 caracteres y rechaza 11', () => {
    expect(groupInput.safeParse({ ...base, code: 'ABCDEFGHIJ' }).success).toBe(true);
    expect(groupInput.safeParse({ ...base, code: 'ABCDEFGHIJK' }).success).toBe(false);
  });
  it('la hora de entrada es opcional (null) y no depende del turno', () => {
    const parsed = groupInput.parse({ ...base, shift: 'matutino' });
    expect(parsed.expectedEntryTime).toBeNull();
    expect(groupInput.parse({ ...base, expectedEntryTime: '07:50' }).shift).toBeNull();
  });
  it.each([
    ['07:00', '07:00:00'],
    ['07:50', '07:50:00'],
    ['13:05', '13:05:00'],
    ['00:00', '00:00:00'],
    ['23:59', '23:59:00'],
    ['08:15:00', '08:15:00'],
  ])('acepta la hora %s y la normaliza a %s', (input, expected) => {
    expect(groupInput.parse({ ...base, expectedEntryTime: input }).expectedEntryTime).toBe(
      expected,
    );
  });
  it.each(['24:00', '25:00', '7:00', '07:5', '07:60', '07:00:30', '07.00', 'siete', '', ' 07:00'])(
    'rechaza la hora %j',
    (input) => {
      expect(groupInput.safeParse({ ...base, expectedEntryTime: input }).success).toBe(false);
    },
  );
  it('acepta turnos conocidos', () => {
    expect(groupInput.safeParse({ ...base, shift: 'vespertino' }).success).toBe(true);
  });
  it.each([
    ['grado 0', { ...base, grade: 0 }],
    ['grado 4', { ...base, grade: 4 }],
    ['grado decimal', { ...base, grade: 1.5 }],
    ['identificador vacio', { ...base, code: '   ' }],
    ['caracteres no permitidos', { ...base, code: 'A_B' }],
    ['acentos', { ...base, code: 'ÁB' }],
    ['guion al borde', { ...base, code: '-A' }],
    ['turno desconocido', { ...base, shift: 'nocturno' }],
    ['ciclo no UUID', { ...base, schoolYearId: '123' }],
  ])('rechaza %s', (_label, input) => {
    expect(groupInput.safeParse(input).success).toBe(false);
  });
});
