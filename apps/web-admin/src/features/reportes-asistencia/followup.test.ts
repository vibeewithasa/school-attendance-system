import type { AttendanceGroupReport } from '@eta15/shared-contracts';
import { describe, expect, it } from 'vitest';
import {
  buildRows,
  isFollowupSort,
  sortRows,
  summarize,
  totalsAreConsistent,
  type FollowupRow,
} from './followup';

/** Transformaciones puras del seguimiento de ausencias (sin red ni DOM). Datos FICTICIOS. */
const student = (
  id: string,
  givenNames: string,
  familyName: string,
  present: number,
  absent: number,
  noMark = 0,
) => ({
  studentId: id,
  givenNames,
  familyName,
  listsApplicable: present + absent + noMark,
  present,
  absent,
  noMark,
});
const report = (
  students: ReturnType<typeof student>[],
  totals: Partial<AttendanceGroupReport['totals']> = {},
): AttendanceGroupReport => {
  const sum = (k: 'present' | 'absent' | 'noMark') => students.reduce((a, s) => a + s[k], 0);
  return {
    generatedAt: '2026-10-28T20:00:00.000Z',
    schoolToday: '2026-10-28',
    group: {
      id: 'g',
      schoolYearId: 'y',
      schoolYearName: '2026-2027',
      grade: 1,
      code: 'A',
      shift: null,
      isActive: true,
    },
    schoolYear: { id: 'y', name: '2026-2027', startsOn: '2026-08-24', endsOn: '2027-07-16' },
    period: { from: '2026-10-12', to: '2026-10-16' },
    days: [],
    students,
    totals: {
      weekdays: 5,
      withList: 5,
      draft: 0,
      finalized: 5,
      withoutList: 0,
      studentDays: sum('present') + sum('absent') + sum('noMark'),
      present: sum('present'),
      absent: sum('absent'),
      noMark: sum('noMark'),
      ...totals,
    },
  };
};
const ids = (rows: readonly FollowupRow[]) => rows.map((r) => r.studentId);

describe('ordenamiento determinista', () => {
  const rows = buildRows(
    report([
      student('3', 'Beto', 'Zamora', 3, 2),
      student('1', 'Ana', 'Zamora', 3, 2), // empata con 3 en ausencias y apellido: decide el nombre
      student('2', 'Carla', 'Álvarez', 5, 0),
      student('4', 'Dora', 'Pérez', 2, 4),
      student('5', 'Eva', 'Pérez', 5, 0), // empata con 2 sin ausencias: decide el apellido
    ]),
  );

  it('mayor numero de ausencias (orden inicial) con desempate por apellidos, nombres e identificador', () => {
    expect(ids(sortRows(rows, 'absences_desc'))).toEqual(['4', '1', '3', '2', '5']);
  });

  it('menor numero de ausencias con el mismo desempate', () => {
    expect(ids(sortRows(rows, 'absences_asc'))).toEqual(['2', '5', '1', '3', '4']);
  });

  it('por nombre del alumno: apellidos y nombres, sin distinguir acentos ni mayusculas', () => {
    expect(ids(sortRows(rows, 'name'))).toEqual(['2', '4', '5', '1', '3']);
  });

  it('el desempate final es el identificador (dos alumnos con el mismo nombre completo)', () => {
    const twins = buildRows(
      report([student('b', 'Mismo', 'Nombre', 1, 1), student('a', 'Mismo', 'Nombre', 1, 1)]),
    );
    expect(ids(sortRows(twins, 'absences_desc'))).toEqual(['a', 'b']);
    expect(ids(sortRows(twins, 'name'))).toEqual(['a', 'b']);
  });

  it('no muta la lista original y es estable ante repeticiones', () => {
    const before = ids(rows);
    const once = ids(sortRows(rows, 'absences_desc'));
    expect(ids(rows)).toEqual(before);
    expect(ids(sortRows(rows, 'absences_desc'))).toEqual(once);
    expect(ids(sortRows(sortRows(rows, 'name'), 'absences_desc'))).toEqual(once);
  });

  it('reconoce solo los criterios definidos', () => {
    expect(['absences_desc', 'absences_asc', 'name'].every(isFollowupSort)).toBe(true);
    expect([null, '', 'riesgo', 'absences'].some(isFollowupSort)).toBe(false);
  });
});

describe('filas: solo lo que el servidor conto, sin inferir', () => {
  it('las ausencias son EXACTAMENTE las marcas ausente: sin marca y fuera del padron no suman', () => {
    const rows = buildRows(
      report([student('1', 'Ana', 'Ficticia', 2, 1, 2)], { withList: 7, finalized: 5, draft: 2 }),
    );
    expect(rows[0]).toMatchObject({ absent: 1, present: 2, noMark: 2, listsApplicable: 5 });
    // 7 listas existen y el alumno esta en el padron de 5: en 2 NO estaba (no es ausencia)
    expect(rows[0]!.listsOutsideRoster).toBe(2);
    expect(rows[0]!.gaps).toHaveLength(2);
    expect(rows[0]!.gaps.join(' ')).toMatch(/sin marca.*borrador/);
    expect(rows[0]!.gaps.join(' ')).toMatch(/No estaba en el padrón de 2 listas.*no es ausencia/);
  });

  it('un alumno presente en todas las listas finalizadas no tiene huecos', () => {
    const rows = buildRows(report([student('1', 'Ana', 'Ficticia', 5, 0)]));
    expect(rows[0]!.gaps).toEqual([]);
    expect(rows[0]!.listsOutsideRoster).toBe(0);
  });

  it('singular y plural de los avisos', () => {
    const one = buildRows(report([student('1', 'A', 'B', 4, 0, 1)], { withList: 6 }))[0]!;
    expect(one.gaps.join(' ')).toMatch(/1 registro sin marca/);
    expect(one.gaps.join(' ')).toMatch(/1 lista /);
  });
});

describe('estado de los datos del periodo', () => {
  it('completo: todos los dias habiles con lista finalizada', () => {
    expect(summarize(report([student('1', 'A', 'B', 5, 0)])).gaps).toEqual([]);
  });

  it('incompleto: dias sin lista (no determinado) y listas en borrador, cada uno con su aviso', () => {
    const s = summarize(
      report([student('1', 'A', 'B', 2, 1)], {
        weekdays: 5,
        withList: 3,
        finalized: 2,
        draft: 1,
        withoutList: 2,
      }),
    );
    expect(s.gaps).toHaveLength(2);
    expect(s.gaps[0]).toMatch(/2 días hábiles sin lista \(no determinado, no es ausencia\)/);
    expect(s.gaps[1]).toMatch(/1 lista en borrador: sus marcas aún pueden cambiar/);
  });

  it('sin ninguna lista: lo dice y no cuenta nada', () => {
    const s = summarize(
      report([], { withList: 0, finalized: 0, draft: 0, withoutList: 5, studentDays: 0 }),
    );
    expect(s.gaps[0]).toMatch(/No hay listas en el periodo/);
  });
});

describe('consistencia de los totales recibidos', () => {
  it('acepta un reporte cuyos cortes suman lo mismo', () => {
    expect(
      totalsAreConsistent(report([student('1', 'A', 'B', 3, 1, 1), student('2', 'C', 'D', 5, 0)])),
    ).toBe(true);
  });

  it('rechaza totales que no coinciden con los alumnos, con los registros o con las listas del alumno', () => {
    const base = report([student('1', 'A', 'B', 3, 1)]);
    expect(totalsAreConsistent({ ...base, totals: { ...base.totals, absent: 2 } })).toBe(false);
    expect(totalsAreConsistent({ ...base, totals: { ...base.totals, studentDays: 99 } })).toBe(
      false,
    );
    expect(
      totalsAreConsistent({ ...base, students: [{ ...base.students[0]!, listsApplicable: 9 }] }),
    ).toBe(false);
  });
});
