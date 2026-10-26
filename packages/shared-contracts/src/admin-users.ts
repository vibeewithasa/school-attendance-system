import { z } from 'zod';

/**
 * Contratos de la administracion de cuentas (/admin/users, /admin/roles). Los comparten la API (validacion) y los
 * clientes (tipos). Ninguna respuesta incluye hashes de contrasena, tokens ni identificadores de sesion.
 */

/** Misma normalizacion que la base exige (`email = lower(btrim(email))`) mas NFKC. Unica para login y altas. */
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export const accountDomainSchema = z.enum(['school', 'technical']);
export const accountStatusSchema = z.enum(['pending', 'active', 'disabled']);
export const emailKindSchema = z.enum(['institutional', 'personal']);
/** Clave de rol (los iniciales: prefectura, trabajo_social, control_acceso, direccion, admin_tecnico). La existencia la valida la base. */
export const roleKeySchema = z.string().regex(/^[a-z][a-z_]{1,39}$/);
export const userIdSchema = z.uuid();

const emailSchema = z
  .string()
  .max(254)
  .transform(normalizeEmail)
  .pipe(
    z
      .string()
      .max(254)
      .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
  );

export const listUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    status: accountStatusSchema.optional(),
    domain: accountDomainSchema.optional(),
    role: roleKeySchema.optional(),
    /** Busqueda por correo o nombre (minimo 2 caracteres). */
    q: z.string().trim().min(2).max(100).optional(),
  })
  .strict();
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** Alta de una cuenta PENDIENTE: sin contrasena (nadie la elige por otra persona) y sin registro publico. */
export const createUserBodySchema = z
  .object({
    email: emailSchema,
    displayName: z.string().trim().min(1).max(120),
    accountDomain: accountDomainSchema,
    emailKind: emailKindSchema.default('institutional'),
  })
  .strict();
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

export const assignRoleBodySchema = z.object({ roleKey: roleKeySchema }).strict();
export type AssignRoleBody = z.infer<typeof assignRoleBodySchema>;

export interface AdminUserRole {
  key: string;
  name: string;
  domain: 'school' | 'technical';
  grantedAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  emailKind: 'institutional' | 'personal';
  displayName: string;
  accountDomain: 'school' | 'technical';
  status: 'pending' | 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
  locked: boolean;
  roles: AdminUserRole[];
  /**
   * Solo para cuentas pendientes: estado de la solicitud de activacion de la propia persona (ver credential-request
   * mas abajo). `null` = aun no la solicito. La administracion NUNCA activa una cuenta ni conoce su contrasena.
   */
  activation: 'requested' | 'authorized' | null;
}

export interface AdminUserList {
  items: AdminUser[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminRole {
  key: string;
  name: string;
  description: string;
  domain: 'school' | 'technical';
  requiresMfa: boolean;
}

/**
 * CONTRATOS PREPARADOS, SIN ENDPOINT TODAVIA (activacion y recuperacion por reclamo en dos partes; ver
 * docs/architecture/auth-rbac.md §6): la persona titular genera un secreto en SU dispositivo y registra solo su SHA-256;
 * una autoridad del dominio verifica su identidad en persona y autoriza la solicitud; la persona completa con el secreto y
 * elige su propia contrasena. No hay enlace que la administracion pueda usar en nombre de otra persona.
 */
export const credentialRequestBodySchema = z
  .object({
    email: emailSchema,
    purpose: z.enum(['invite', 'password_reset']),
    /** SHA-256 del secreto generado por la persona, en base64url (43 caracteres). */
    secretHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const authorizeCredentialRequestBodySchema = z
  .object({ verificationMethod: z.enum(['in_person_id', 'in_person_known']) })
  .strict();
export const completeCredentialRequestBodySchema = z
  .object({
    /** Secreto original (el titular lo conserva; la API solo recibe su hash al solicitar). */
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();
