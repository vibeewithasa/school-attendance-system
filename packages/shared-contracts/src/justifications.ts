import { z } from 'zod';
import type { GroupRefDto } from './students.js';

/**
 * Contratos del registro de RECEPCION de justificantes (Trabajo Social, MVP; migracion 0013).
 *
 * Un registro es un HECHO ADMINISTRATIVO: "se recibio un justificante del alumno X para el dia escolar D". NO es una aprobacion, no
 * justifica ninguna falta, no modifica la asistencia ni los reportes, y no se enlaza a `attendance_records`: la decision
 * institucional D-10 sigue pendiente. Datos minimos: sin motivo, diagnostico, descripcion, adjunto, contacto ni texto libre.
 *
 * Fechas: dias de calendario de la escuela (America/Mazatlan), solo lunes a viernes, no futuras y dentro de la matricula del
 * alumno. `receivedAt` y `receivedBy` los fija el SERVIDOR: ningun contrato admite hora de recepcion, actor ni folio.
 */
const isoDate = z.iso.date();

/** Unico estado tecnico. No existen 'approved' ni 'rejected': no hay decision institucional. */
export const JUSTIFICATION_STATUSES = ['received'] as const;
export type JustificationStatus = (typeof JUSTIFICATION_STATUSES)[number];

/**
 * Registrar la recepcion. `requestId` (UUID generado por el cliente por cada envio) hace seguro el reintento y el doble clic: repetirlo
 * con el mismo contenido devuelve el mismo registro; reusarlo con otro alumno o fecha se rechaza (409).
 */
export const createJustificationReceiptBody = z
  .object({
    requestId: z.uuid().transform((id) => id.toLowerCase()),
    studentId: z.uuid().transform((id) => id.toLowerCase()),
    schoolDate: isoDate,
  })
  .strict();
export type CreateJustificationReceiptBody = z.infer<typeof createJustificationReceiptBody>;

/** Busqueda de alumno por nombre (minimo 3 caracteres, para no listar a los menores a base de prefijos cortos). */
export const JUSTIFICATION_SEARCH_MIN = 3;
export const JUSTIFICATION_SEARCH_LIMIT = 20;
export const searchJustificationStudentsQuery = z
  .object({
    q: z
      .string()
      .transform((s) => s.normalize('NFC').trim().replace(/\s+/g, ' '))
      .pipe(
        z
          .string()
          .min(JUSTIFICATION_SEARCH_MIN, `Escribe al menos ${JUSTIFICATION_SEARCH_MIN} letras`)
          .max(100),
      ),
  })
  .strict();
export type SearchJustificationStudentsQuery = z.infer<typeof searchJustificationStudentsQuery>;

export const listJustificationReceiptsQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    studentId: z.uuid().optional(),
    /** Rango INCLUSIVO sobre la fecha escolar del justificante. */
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'El inicio del rango no puede ser posterior al fin',
    path: ['from'],
  });
export type ListJustificationReceiptsQuery = z.infer<typeof listJustificationReceiptsQuery>;

export interface JustificationReceiptDto {
  id: string;
  /** Folio administrativo unico ('JR-000001'). Lo asigna la base. */
  folio: string;
  status: JustificationStatus;
  student: { id: string; givenNames: string; familyName: string };
  /** Dia escolar al que se refiere el justificante. */
  schoolDate: string;
  /** Momento de la recepcion, fijado por el servidor. */
  receivedAt: string;
  /** Quien lo recibio (cuenta autenticada que hizo el registro). */
  receivedBy: { id: string; displayName: string };
}

export interface CreateJustificationReceiptResponse {
  receipt: JustificationReceiptDto;
  /** true si `requestId` ya estaba registrado con el mismo contenido: se devuelve el mismo registro sin crear otro. */
  replayed: boolean;
}

export interface JustificationReceiptList {
  items: JustificationReceiptDto[];
  page: number;
  pageSize: number;
  total: number;
}

/** Datos minimos para ELEGIR al alumno (el grupo actual solo distingue homonimos; nunca se guarda en el registro). */
export interface JustificationStudentOptionDto {
  id: string;
  givenNames: string;
  familyName: string;
  schoolCode: string | null;
  currentGroup: GroupRefDto | null;
}

export interface JustificationStudentSearch {
  items: JustificationStudentOptionDto[];
  /** true si hay mas coincidencias que las mostradas: conviene precisar la busqueda. */
  truncated: boolean;
}
