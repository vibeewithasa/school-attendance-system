import type { AttendanceGroupReport } from '@eta15/shared-contracts';

/**
 * Seguimiento de ausencias REGISTRADAS: transformacion PURA del reporte por grupo (PR #9). No consulta nada nuevo ni calcula
 * porcentajes, umbrales, niveles de riesgo ni alertas: solo reordena y describe lo que el servidor ya contó.
 *  - "Ausencias registradas" = marcas `absent` explicitas en las listas (borrador o finalizada). Sin lista, sin marca, fuera del
 *    padron, fines de semana y recibos de idempotencia NUNCA suman (el servidor no los cuenta; aqui tampoco se infiere nada).
 *  - Los justificantes recibidos NO descuentan ausencias (decision D-10 pendiente).
 */
export type FollowupSort = 'absences_desc' | 'absences_asc' | 'name';

export const SORT_LABELS: Record<FollowupSort, string> = {
  absences_desc: 'Mayor número de ausencias registradas',
  absences_asc: 'Menor número de ausencias registradas',
  name: 'Nombre del alumno',
};
export const DEFAULT_SORT: FollowupSort = 'absences_desc';
export const isFollowupSort = (value: string | null): value is FollowupSort =>
  value === 'absences_desc' || value === 'absences_asc' || value === 'name';

export interface FollowupRow {
  studentId: string;
  givenNames: string;
  familyName: string;
  /** Listas del periodo cuyo padron congelado incluye al alumno. */
  listsApplicable: number;
  present: number;
  absent: number;
  noMark: number;
  /** Listas del periodo en las que el alumno NO estaba en el padron (incorporado despues o dado de baja antes): no son ausencia. */
  listsOutsideRoster: number;
  /** Motivos por los que el dato de este alumno esta incompleto (vacio = completo para las listas existentes). */
  gaps: string[];
}

export interface FollowupSummary {
  weekdays: number;
  withList: number;
  finalized: number;
  draft: number;
  withoutList: number;
  /** Motivos por los que el periodo esta incompleto (vacio = todos los dias habiles tienen lista finalizada). */
  gaps: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summarize(report: AttendanceGroupReport): FollowupSummary {
  const t = report.totals;
  const gaps: string[] = [];
  if (t.withList === 0) gaps.push('No hay listas en el periodo: no hay marcas que contar.');
  if (t.withoutList > 0)
    gaps.push(
      `${plural(t.withoutList, 'día hábil sin lista', 'días hábiles sin lista')} (no determinado, no es ausencia).`,
    );
  if (t.draft > 0)
    gaps.push(
      `${plural(t.draft, 'lista en borrador', 'listas en borrador')}: sus marcas aún pueden cambiar.`,
    );
  return {
    weekdays: t.weekdays,
    withList: t.withList,
    finalized: t.finalized,
    draft: t.draft,
    withoutList: t.withoutList,
    gaps,
  };
}

export function buildRows(report: AttendanceGroupReport): FollowupRow[] {
  const withList = report.totals.withList;
  return report.students.map((s) => {
    const outside = Math.max(0, withList - s.listsApplicable);
    const gaps: string[] = [];
    if (s.noMark > 0)
      gaps.push(
        `${plural(s.noMark, 'registro sin marca', 'registros sin marca')} (lista en borrador).`,
      );
    if (outside > 0)
      gaps.push(
        `No estaba en el padrón de ${plural(outside, 'lista', 'listas')} del periodo (no es ausencia).`,
      );
    return {
      studentId: s.studentId,
      givenNames: s.givenNames,
      familyName: s.familyName,
      listsApplicable: s.listsApplicable,
      present: s.present,
      absent: s.absent,
      noMark: s.noMark,
      listsOutsideRoster: outside,
      gaps,
    };
  });
}

const collator = new Intl.Collator('es', { sensitivity: 'base' });
const byName = (a: FollowupRow, b: FollowupRow) =>
  collator.compare(a.familyName, b.familyName) ||
  collator.compare(a.givenNames, b.givenNames) ||
  (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0);

/** Orden determinista: el criterio elegido y, en empates, nombre (apellidos, nombres) y por ultimo el identificador. */
export function sortRows(rows: readonly FollowupRow[], sort: FollowupSort): FollowupRow[] {
  const copy = [...rows];
  switch (sort) {
    case 'absences_desc':
      return copy.sort((a, b) => b.absent - a.absent || byName(a, b));
    case 'absences_asc':
      return copy.sort((a, b) => a.absent - b.absent || byName(a, b));
    default:
      return copy.sort(byName);
  }
}

/** Comprobacion de consistencia del reporte recibido: los cortes por alumno deben sumar lo mismo que los totales del grupo. */
export function totalsAreConsistent(report: AttendanceGroupReport): boolean {
  const sum = (k: 'present' | 'absent' | 'noMark') =>
    report.students.reduce((acc, s) => acc + s[k], 0);
  const t = report.totals;
  return (
    sum('present') === t.present &&
    sum('absent') === t.absent &&
    sum('noMark') === t.noMark &&
    t.present + t.absent + t.noMark === t.studentDays &&
    report.students.every((s) => s.present + s.absent + s.noMark === s.listsApplicable)
  );
}
