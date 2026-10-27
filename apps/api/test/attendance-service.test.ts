import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { isSchoolWeekday, marksHash } from '../src/modules/attendance/attendance.service.js';

/** Reglas puras de la asistencia: dia laborable, huella de un guardado y zona horaria escolar. Sin datos de personas. */
describe('dia laborable (lunes a viernes)', () => {
  it.each([
    ['2026-10-26', true], // lunes
    ['2026-10-27', true],
    ['2026-10-28', true],
    ['2026-10-29', true],
    ['2026-10-30', true], // viernes
    ['2026-10-31', false], // sabado
    ['2026-11-01', false], // domingo
  ])('%s => %s', (date, expected) => expect(isSchoolWeekday(date)).toBe(expected));

  it('no depende de la zona horaria del proceso (la fecha es de calendario)', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/Mazatlan', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
        process.env.TZ = zone;
        expect(isSchoolWeekday('2026-10-31')).toBe(false);
        expect(isSchoolWeekday('2026-10-30')).toBe(true);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('huella del guardado (idempotencia)', () => {
  const a = { studentId: '00000000-0000-4000-8000-000000000001', status: 'present' as const };
  const b = { studentId: '00000000-0000-4000-8000-000000000002', status: 'absent' as const };

  it('es hexadecimal de 64 caracteres, estable e independiente del orden de los alumnos', () => {
    expect(marksHash([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(marksHash([a, b])).toBe(marksHash([b, a]));
    expect(marksHash([a])).toBe(marksHash([a]));
  });

  it('cambia con cualquier cambio de estado o de alumno', () => {
    expect(marksHash([a, b])).not.toBe(marksHash([a, { ...b, status: 'present' }]));
    expect(marksHash([a])).not.toBe(marksHash([{ ...a, studentId: b.studentId }]));
    expect(marksHash([a])).not.toBe(marksHash([a, b]));
  });
});

describe('zona horaria escolar America/Mazatlan (UTC-7, sin horario de verano)', () => {
  let db: PGlite | undefined;
  afterAll(async () => db?.close());
  it('el dia escolar lo decide la hora de Mazatlan, no la de UTC', async () => {
    db = new PGlite();
    const day = async (instant: string) =>
      (
        await db!.query<{ d: string }>(
          `select to_char(($1::timestamptz at time zone 'America/Mazatlan')::date, 'YYYY-MM-DD') d`,
          [instant],
        )
      ).rows[0]!.d;
    expect(await day('2026-10-29T03:00:00Z')).toBe('2026-10-28'); // 20:00 del miercoles en Mazatlan
    expect(await day('2026-10-29T06:59:59Z')).toBe('2026-10-28'); // 23:59:59 del miercoles
    expect(await day('2026-10-29T07:00:00Z')).toBe('2026-10-29'); // medianoche local: cambia el dia escolar
    expect(await day('2026-07-15T06:59:59Z')).toBe('2026-07-14'); // en verano tambien UTC-7 (sin horario de verano)
    expect(await day('2026-07-15T07:00:00Z')).toBe('2026-07-15');
  });
});
