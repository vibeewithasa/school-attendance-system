/**
 * Cableado HTTP del modulo de autenticacion: cabeceras de seguridad, cookies, guarda de origen (CSRF), limite de
 * peticiones y rutas /auth/*. Las dependencias (almacen SQL, servicio de contrasenas, reloj) se inyectan.
 */
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { ApiErrorBody } from '@eta15/shared-contracts';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { createAttemptLimiter } from './attempt-limiter.js';
import { createAuthService } from './auth-service.js';
import { adminUsersRoutes } from '../admin-users/admin-users.routes.js';
import { createAdminUsersService } from '../admin-users/admin-users.service.js';
import { authRoutes } from './auth.routes.js';
import { createAuthGuards } from './guards.js';
import { schoolCatalogRoutes } from '../school-catalog/school-catalog.routes.js';
import { createSchoolCatalogService } from '../school-catalog/school-catalog.service.js';
import {
  myGroupsRoute,
  prefectAssignmentsRoutes,
} from '../prefect-assignments/prefect-assignments.routes.js';
import {
  createPrefectAssignmentsService,
  lockGroupAccess,
  pgGroupAssignments,
} from '../prefect-assignments/prefect-assignments.service.js';
import { attendanceRoutes } from '../attendance/attendance.routes.js';
import { mobileAttendanceRoutes } from '../attendance/attendance.mobile.js';
import {
  createAttendanceService,
  type AttendanceService,
} from '../attendance/attendance.service.js';
import { groupRosterRoute, studentsRoutes } from '../students/students.routes.js';
import { createStudentsService } from '../students/students.service.js';
import { activationAdminRoutes, activationPublicRoutes } from '../activation/activation.routes.js';
import { createActivationService } from '../activation/activation.service.js';
import { checkRequestOrigin, isUnsafeMethod, parseAllowedOrigins } from './csrf.js';
import { createPasswordService, type PasswordService } from './password.js';
import {
  SANDBOX_MOBILE_DEFAULTS,
  coarseIp,
  createMobileAuthService,
  type MobileAuthConfig,
} from '../mobile-auth/mobile-auth.service.js';
import { createMobileGuards } from '../mobile-auth/mobile-guards.js';
import { mobileRoutes } from '../mobile-auth/mobile-auth.routes.js';
import { mobileDevicesRoutes } from '../mobile-auth/mobile-devices.routes.js';
import { createSessionService, type SessionService, type SessionStore } from './session-service.js';

export interface AuthModuleOptions {
  store: SessionStore;
  passwords?: PasswordService;
  clock?: () => Date;
  /** Valores por defecto: ver `DEFAULT_AUTH_LIMITS`. Sobrescribibles en pruebas. */
  limits?: Partial<AuthLimits>;
  /** SOLO PRUEBAS: "hoy" escolar (YYYY-MM-DD) de la asistencia. En produccion lo calcula la base (America/Mazatlan). */
  schoolToday?: () => string;
  /**
   * AUTENTICACION MOVIL AISLADA (prototipo de sandbox; ADR 0005 propuesto, no aceptado). Sin esta opcion no existe NINGUNA ruta
   * /mobile ni /mobile-devices. Se rechaza con NODE_ENV=production.
   */
  mobile?: MobileAuthModuleOptions;
}

export interface MobileAuthModuleOptions {
  /** Base canonica de las URL para el htu de DPoP (p. ej. http://10.0.2.2:3000 para el emulador). Obligatoria. */
  publicBaseUrl: string;
  /** Tiempos de ENSAYO (ver SANDBOX_MOBILE_DEFAULTS); no son politica institucional. */
  config?: Partial<Omit<MobileAuthConfig, 'publicBaseUrl'>>;
  /** Reloj inyectable (pruebas). */
  clock?: () => Date;
  limits?: Partial<MobileLimits>;
  /**
   * LECTURA de asistencia por el canal movil (ADR 0006, propuesto): rutas GET /mobile/school/attendance/{today,days,days/:id}.
   * Apagado por omision. Solo sandbox: hereda la prohibicion de NODE_ENV=production de `mobile` y la repite aqui.
   */
  attendanceRead?: boolean;
  /**
   * ESCRITURA de asistencia por el canal movil (ADR 0006, fase 2): solo POST /mobile/school/attendance/days (abrir) y
   * .../days/:id/marks (guardar). Apagado por omision. Exige `attendanceRead` y `mobile` (error al construir si falta); hereda la
   * prohibicion de NODE_ENV=production. No existen finalizar, borrar ni capturas historicas.
   */
  attendanceWrite?: boolean;
}

export interface MobileLimits {
  /** Solicitudes de vinculacion por IP y ventana. */
  enrollIp: number;
  /** Nonces pedidos por IP y ventana. */
  challengeIp: number;
  /** Fallos de credenciales moviles por IP y por clave de dispositivo. */
  tokenFailIp: number;
  tokenFailKey: number;
  /** Reclamos fallidos por cuenta. */
  claimFailUser: number;
}

export const DEFAULT_MOBILE_LIMITS: MobileLimits = {
  enrollIp: 10,
  challengeIp: 120,
  tokenFailIp: 30,
  tokenFailKey: 10,
  claimFailUser: 10,
};

export interface AuthLimits {
  /** Ventana de los contadores de fallos (ms). */
  windowMs: number;
  /** Fallos por IP (una IP compartida, p. ej. la red de la escuela, necesita margen amplio). */
  ipFailures: number;
  /** Fallos por pareja IP + correo: frena la adivinacion dirigida desde una misma maquina. */
  pairFailures: number;
  /** Fallos por correo desde cualquier IP: alto, para que un tercero no bloquee la cuenta de otra persona con facilidad. */
  identityFailures: number;
  /** Peticiones por minuto y por IP (inundacion) en login y en el resto de /auth. */
  floodLogin: number;
  floodOther: number;
  /** Activacion: solicitudes por IP, por correo (desde cualquier IP) y finalizaciones fallidas por IP, por ventana. */
  activationRequestIp: number;
  activationRequestAccount: number;
  activationCompleteFailures: number;
  now?: () => number;
}

export const DEFAULT_AUTH_LIMITS: AuthLimits = {
  windowMs: 15 * 60_000,
  ipFailures: 50,
  pairFailures: 5,
  identityFailures: 30,
  floodLogin: 120,
  floodOther: 600,
  activationRequestIp: 30,
  activationRequestAccount: 5,
  activationCompleteFailures: 10,
};

/** Seguridad HTTP comun: helmet, cookies y rechazo de peticiones que cambian estado desde origenes no permitidos. */
export async function registerHttpSecurity(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(helmet);
  await app.register(cookie); // sin firma: el valor de la cookie es un token aleatorio opaco

  const allowed = parseAllowedOrigins(env.CORS_ORIGIN);
  app.addHook('onRequest', async (request, reply) => {
    if (!isUnsafeMethod(request.method)) return;
    // Canal movil: sin cookies ni credenciales ambientales (token + prueba DPoP por peticion) y rechaza cualquier Origin
    // en su propio guarda, de modo que un navegador no puede usarlo. Es una exencion por RUTA, no global.
    if (request.routeOptions?.config?.mobileChannel === true) return;
    const verdict = checkRequestOrigin(request.headers, allowed);
    if (verdict === 'ok') return;
    request.log.warn({ verdict }, 'peticion rechazada por origen');
    const body: ApiErrorBody = {
      error: { code: 'FORBIDDEN_ORIGIN', message: 'Origen no permitido', requestId: request.id },
    };
    return reply.code(403).send(body);
  });
}

export async function registerAuth(
  app: FastifyInstance,
  env: Env,
  options: AuthModuleOptions,
): Promise<{ sessions: SessionService }> {
  const limits = { ...DEFAULT_AUTH_LIMITS, ...options.limits };
  const passwords = options.passwords ?? createPasswordService();
  const sessions = createSessionService({
    store: options.store,
    clock: options.clock,
    mfaEnforcement: env.AUTH_MFA_ENFORCEMENT,
  });
  if (env.AUTH_MFA_ENFORCEMENT === 'deferred') {
    // Aviso visible en cada arranque: es una excepcion de desarrollo local, no una configuracion de despliegue.
    app.log.warn(
      { mfa: 'deferred' },
      'MFA DIFERIDO (AUTH_MFA_ENFORCEMENT=deferred): direccion y admin_tecnico entran solo con contrasena. Solo desarrollo local; no usar con datos reales.',
    );
  }
  const auth = createAuthService({
    store: options.store,
    sessions,
    passwords,
    onIntegrityProblem: (code) =>
      app.log.error({ code }, 'hash de contrasena almacenado no valido'),
  });
  const guards = createAuthGuards({ sessions, production: env.NODE_ENV === 'production' });
  const limiter = (max: number) =>
    createAttemptLimiter({ max, windowMs: limits.windowMs, now: limits.now });

  // keyGenerator por IP de la conexion (no se confia en X-Forwarded-For: trustProxy esta desactivado).
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () =>
      new AppError(429, 'RATE_LIMITED', 'Demasiados intentos. Intente más tarde.'),
  });

  await app.register(
    async (scope) => {
      authRoutes(scope, {
        auth,
        sessions,
        guards,
        limiters: {
          ip: limiter(limits.ipFailures),
          pair: limiter(limits.pairFailures),
          identity: limiter(limits.identityFailures),
        },
        floodLimit: { login: limits.floodLogin, other: limits.floodOther },
      });
    },
    { prefix: '/auth' },
  );

  // Administracion de cuentas: solo traduce HTTP al servicio; el actor sale de la sesion.
  await app.register(
    async (scope) => {
      adminUsersRoutes(scope, {
        service: createAdminUsersService({ store: options.store }),
        guards,
        mfaDeferredAllowed:
          env.AUTH_MFA_ENFORCEMENT === 'deferred' && env.NODE_ENV !== 'production',
        floodLimit: limits.floodOther,
      });
    },
    { prefix: '/admin' },
  );
  // Activacion de cuentas pendientes (reclamo en dos partes): rutas publicas del titular y rutas de la autoridad.
  const activation = createActivationService({ store: options.store, passwords });
  await app.register(
    async (scope) => {
      activationPublicRoutes(scope, {
        service: activation,
        limiters: {
          requestIp: limiter(limits.activationRequestIp),
          requestAccount: limiter(limits.activationRequestAccount),
          completeFailIp: limiter(limits.activationCompleteFailures),
        },
        floodLimit: limits.floodOther,
      });
    },
    { prefix: '/auth/activation' },
  );
  await app.register(
    async (scope) => {
      activationAdminRoutes(scope, {
        service: activation,
        guards,
        mfaDeferredAllowed:
          env.AUTH_MFA_ENFORCEMENT === 'deferred' && env.NODE_ENV !== 'production',
        floodLimit: limits.floodOther,
      });
    },
    { prefix: '/admin' },
  );
  // Catalogo escolar (ciclos y grupos): lectura con catalog:read, escritura con catalog:manage_school (Direccion; ver school-catalog.routes.ts).
  await app.register(
    async (scope) => {
      schoolCatalogRoutes(scope, {
        service: createSchoolCatalogService({ store: options.store }),
        guards,
        mfaDeferredAllowed:
          env.AUTH_MFA_ENFORCEMENT === 'deferred' && env.NODE_ENV !== 'production',
        floodLimit: limits.floodOther,
      });
    },
    { prefix: '/catalog' },
  );
  // Alumnos, matriculas e historial de grupo (datos de menores): permisos students:* / enrollments:manage con alcance (ver students.service.ts).
  // UN solo servicio de asistencia: el portal (/school/attendance) y la lectura movil (/mobile/school/attendance, solo sandbox y solo
  // con `mobile.attendanceRead`) comparten reglas de alcance, fecha y revision; no hay una segunda implementacion.
  const attendanceService = createAttendanceService({
    store: options.store,
    assignments: pgGroupAssignments,
    lockGroupAccess,
    today: options.schoolToday,
  });
  await app.register(
    async (scope) => {
      studentsRoutes(scope, {
        // El alcance assigned_groups se resuelve con las asignaciones REALES de prefectura, dentro de la transaccion de cada consulta.
        service: createStudentsService({ store: options.store, assignments: pgGroupAssignments }),
        guards,
        mfaDeferredAllowed:
          env.AUTH_MFA_ENFORCEMENT === 'deferred' && env.NODE_ENV !== 'production',
        floodLimit: limits.floodOther,
      });
      // Asignaciones de grupos a prefectura: administra Direccion; la prefectura solo consulta las suyas (/me/groups).
      prefectAssignmentsRoutes(scope, {
        service: createPrefectAssignmentsService({ store: options.store }),
        guards,
        mfaDeferredAllowed:
          env.AUTH_MFA_ENFORCEMENT === 'deferred' && env.NODE_ENV !== 'production',
        floodLimit: limits.floodOther,
      });
      // Asistencia diaria (una lista por grupo y fecha): captura la prefectura de sus grupos, Direccion supervisa (ver attendance.service.ts).
      attendanceRoutes(scope, {
        service: attendanceService,
        guards,
        mfaDeferredAllowed:
          env.AUTH_MFA_ENFORCEMENT === 'deferred' && env.NODE_ENV !== 'production',
        floodLimit: limits.floodOther,
      });
    },
    { prefix: '/school' },
  );
  if (options.mobile) {
    if (env.NODE_ENV === 'production')
      throw new Error('La autenticacion movil de sandbox no se habilita con NODE_ENV=production');
    await registerMobile(app, env, options.mobile, {
      store: options.store,
      guards,
      limits,
      limiter,
      attendance: attendanceService,
    });
  }
  return { sessions };
}

async function registerMobile(
  app: FastifyInstance,
  env: Env,
  mobile: MobileAuthModuleOptions,
  deps: {
    store: SessionStore;
    guards: ReturnType<typeof createAuthGuards>;
    limits: AuthLimits;
    limiter: (max: number) => ReturnType<typeof createAttemptLimiter>;
    /** El MISMO servicio de asistencia del portal (mismas reglas de alcance, fecha y revision). */
    attendance: AttendanceService;
  },
): Promise<void> {
  const { store, guards, limits, limiter } = deps;
  if (mobile.attendanceRead && env.NODE_ENV === 'production')
    throw new Error('La lectura movil de asistencia no se habilita con NODE_ENV=production');
  if (mobile.attendanceWrite && env.NODE_ENV === 'production')
    throw new Error('La escritura movil de asistencia no se habilita con NODE_ENV=production');
  // La escritura NUNCA se enciende sola: exige expresamente la lectura (falla cerrado al construir la aplicacion).
  if (mobile.attendanceWrite && !mobile.attendanceRead)
    throw new Error('mobile.attendanceWrite exige mobile.attendanceRead');
  const config: MobileAuthConfig = {
    ...SANDBOX_MOBILE_DEFAULTS,
    ...mobile.config,
    publicBaseUrl: mobile.publicBaseUrl.replace(/\/+$/, ''),
    // Una sola fuente: el interruptor explicito. `mobile.config` no puede encenderlo por la puerta de atras.
    attendanceRead: mobile.attendanceRead === true,
    attendanceWrite: mobile.attendanceWrite === true,
  };
  const mLimits = { ...DEFAULT_MOBILE_LIMITS, ...mobile.limits };
  // Los limites de solicitudes por IP y de reclamos fallidos por cuenta son COMPARTIDOS: los aplica el servicio con PostgreSQL.
  if (mobile.limits?.enrollIp !== undefined) config.maxRequestsPerIp = mLimits.enrollIp;
  if (mobile.limits?.claimFailUser !== undefined)
    config.maxClaimFailuresPerUser = mLimits.claimFailUser;
  if (!/^https?:\/\/[^/\s]+$/.test(config.publicBaseUrl))
    throw new Error('publicBaseUrl debe ser esquema + host (+ puerto), sin ruta');
  if (
    config.accessTtlSeconds > config.absoluteTtlSeconds ||
    config.idleTtlSeconds > config.absoluteTtlSeconds
  )
    throw new Error('Los tiempos moviles deben cumplir acceso e inactividad <= duracion absoluta');
  // La fila de una prueba/nonce vive como maximo 15 minutos (CHECK de la base): la ventana de aceptacion debe caber.
  if (config.proofSkewSeconds * 2 + 5 > 900 || config.nonceTtlSeconds > 900)
    throw new Error('La tolerancia de reloj y la vida del nonce deben caber en 15 minutos');
  if (config.maxProofsPerKey < 1 || config.maxNoncesPerKey < 1 || config.maxPendingPerIp < 1)
    throw new Error('Los cupos moviles deben ser positivos');
  // La proteccion anti-replay y los nonces son estado COMPARTIDO en PostgreSQL (tablas de la 0011), no memoria del proceso.
  const service = createMobileAuthService({ store, config, clock: mobile.clock });
  const mobileGuards = createMobileGuards({ service, config, clock: mobile.clock });
  const mfaDeferredAllowed =
    env.AUTH_MFA_ENFORCEMENT === 'deferred' && env.NODE_ENV !== 'production';

  // Canal MOVIL (sin cookies): enrolamiento de dispositivos y sesiones DPoP.
  await app.register(
    async (scope) => {
      mobileRoutes(scope, {
        service,
        guards: mobileGuards,
        config,
        limiters: {
          challengeIp: limiter(mLimits.challengeIp),
          tokenFailIp: limiter(mLimits.tokenFailIp),
          tokenFailKey: limiter(mLimits.tokenFailKey),
        },
        floodLimit: limits.floodOther,
      });
    },
    { prefix: '/mobile' },
  );
  // Lecturas escolares por el canal movil: los MISMOS handlers y servicios que el portal, con autenticacion movil. Solo estas dos
  // rutas existen aqui; ninguna administrativa.
  await app.register(
    async (scope) => {
      scope.addHook('onSend', (_request, reply, payload, done) => {
        reply.header('Cache-Control', 'no-store');
        done(null, payload);
      });
      const route = {
        config: {
          mobileChannel: true,
          rateLimit: { max: limits.floodOther, timeWindow: '1 minute' },
        },
        preHandler: [mobileGuards.channelGuard, mobileGuards.accessGuard],
      };
      myGroupsRoute(scope, { service: createPrefectAssignmentsService({ store }), ...route });
      groupRosterRoute(scope, {
        service: createStudentsService({ store, assignments: pgGroupAssignments }),
        ...route,
      });
      // LECTURA de asistencia (ADR 0006, propuesto): solo con el interruptor explicito; sin el, estas rutas NO existen (404).
      if (config.attendanceRead) {
        void scope.register(
          async (attendanceScope) =>
            mobileAttendanceRoutes(
              attendanceScope,
              {
                service: deps.attendance,
                write: config.attendanceWrite === true,
                config: route.config,
                preHandler: route.preHandler,
              },
              coarseIp,
            ),
          { prefix: '/attendance' },
        );
      }
    },
    { prefix: '/mobile/school' },
  );
  // Canal WEB (cookie + CSRF + Origin): la persona titular reclama y la autoridad aprueba y revoca.
  await app.register(
    async (scope) => {
      mobileDevicesRoutes(scope, {
        service,
        guards,
        mfaDeferredAllowed,
        floodLimit: limits.floodOther,
      });
    },
    { prefix: '/mobile-devices' },
  );
}
