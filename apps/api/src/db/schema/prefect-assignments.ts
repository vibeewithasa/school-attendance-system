import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './_columns.js';
import { users } from './auth.js';
import { groups, schoolYears } from './school-catalog.js';

/**
 * Asignaciones de grupos a prefectura (alcance `assigned_groups`). Ver docs/architecture/modelo-asignaciones-prefectura.md.
 *
 * Convenciones: UUID v7; sin borrado fisico; periodos INCLUSIVOS (`ends_on` es el ultimo dia con acceso; NULL = sin fecha de fin);
 * `school_year_id` se repite a proposito (redundancia CONTROLADA) para que la FK compuesta `(group_id, school_year_id)` obligue a
 * que el grupo pertenezca al ciclo. Una prefecta puede tener varios grupos y un grupo varias prefectas (cobertura).
 *
 * Tres hechos distintos, nunca mezclados:
 *  - cierre PROGRAMADO: `ends_on` (el acceso termina al acabar ese dia);
 *  - REVOCACION inmediata: `revoked_at/by/reason` (el acceso termina en ese instante; el registro queda como historia y NO se reabre);
 *  - HISTORIAL: la fila completa se conserva siempre.
 */
export const prefectGroupAssignments = pgTable(
  'prefect_group_assignments',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    schoolYearId: uuid('school_year_id').notNull(),
    groupId: uuid('group_id').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }),
    /** Quien asigno (Direccion). Lo escribe el servidor con la sesion, nunca el cliente. */
    createdBy: uuid('created_by').notNull(),
    /** El trigger fija `revoked_at = now()` cuando se escribe `revoked_by`: el cliente no elige la hora. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    revocationReason: text('revocation_reason'),
    ...timestamps,
  },
  (t) => [
    foreignKey({ name: 'pga_user_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'pga_school_year_fkey',
      columns: [t.schoolYearId],
      foreignColumns: [schoolYears.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'pga_group_year_fkey',
      columns: [t.groupId, t.schoolYearId],
      foreignColumns: [groups.id, groups.schoolYearId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({ name: 'pga_created_by_fkey', columns: [t.createdBy], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({ name: 'pga_revoked_by_fkey', columns: [t.revokedBy], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('pga_dates_ordered', sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`),
    check(
      'pga_revocation_consistent',
      sql`(${t.revokedAt} IS NULL AND ${t.revokedBy} IS NULL AND ${t.revocationReason} IS NULL) OR (${t.revokedAt} IS NOT NULL AND ${t.revokedBy} IS NOT NULL AND ${t.revocationReason} IS NOT NULL)`,
    ),
    check(
      'pga_reason_clean',
      sql`${t.revocationReason} IS NULL OR (${t.revocationReason} = btrim(${t.revocationReason}) AND ${t.revocationReason} !~ '[[:cntrl:]]' AND char_length(${t.revocationReason}) BETWEEN 3 AND 200)`,
    ),
    index('pga_user_idx').on(t.userId, t.startsOn),
    index('pga_group_idx').on(t.groupId, t.startsOn),
    // Ademas (migracion 0009, a mano): EXCLUDE USING gist (user_id WITH =, group_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
    // WHERE (revoked_at IS NULL), y los triggers de integridad.
  ],
);

export type PrefectGroupAssignment = typeof prefectGroupAssignments.$inferSelect;
