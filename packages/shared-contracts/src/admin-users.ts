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
