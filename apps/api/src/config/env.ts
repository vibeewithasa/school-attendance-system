import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGIN: z.string().default('http://127.0.0.1:5173'),
    DB_HOST: z.string().default('127.0.0.1'),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DB_NAME: z.string().default('eta15_dev'),
    DB_USER: z.string().default('eta15_app'),
    DB_PASSWORD: z.string().optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
    READY_TIMEOUT_MS: z.coerce.number().int().min(50).max(30_000).default(2000),
    /**
     * Politica de MFA para los roles con roles.requires_mfa (direccion, admin_tecnico).
     *  - required (POR DEFECTO): sin segundo factor verificado no hay sesion. Como todavia no existe MFA, esos roles no pueden entrar.
     *  - deferred: DECISION DEL MVP (MFA pospuesto). Entran con correo y contrasena; la sesion queda SIN mfa_verified_at y cada alta
     *    se audita (auth.session_without_mfa). Solo es valido en desarrollo local: se rechaza con NODE_ENV=production o si el
     *    servidor o la base no estan en loopback. Ver docs/architecture/auth-rbac.md §11.
     */
    AUTH_MFA_ENFORCEMENT: z.enum(['required', 'deferred']).default('required'),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MFA_ENFORCEMENT !== 'deferred') return;
    const loopback = (host: string) => ['127.0.0.1', 'localhost', '::1'].includes(host);
    if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MFA_ENFORCEMENT'],
        message: 'deferred no esta permitido con NODE_ENV=production',
      });
    }
    if (!loopback(env.HOST) || !loopback(env.DB_HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MFA_ENFORCEMENT'],
        message: 'deferred solo se permite con HOST y DB_HOST en loopback (desarrollo local)',
      });
    }
  });

export type Env = z.infer<typeof schema>;

/** Valida las variables de entorno y falla con un mensaje claro (sin imprimir valores). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuracion invalida: ${problems}`);
  }
  return result.data;
}
