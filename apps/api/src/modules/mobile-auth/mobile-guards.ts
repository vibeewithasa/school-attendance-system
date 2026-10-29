/**
 * Guardas del CANAL MOVIL (/mobile/*). Separados a proposito de los guardas web (cookie + CSRF + Origin):
 *  - NUNCA leen la cookie de sesion ni X-CSRF-Token: una cookie web no autentica ninguna ruta movil.
 *  - `Origin` no es prueba de identidad: un cliente nativo no lo envia, y un navegador SIEMPRE lo envia en un POST; por eso el canal
 *    movil RECHAZA cualquier peticion que lo traiga (un navegador no puede usar estas rutas). La exencion del hook global de Origin
 *    es por RUTA (`config.mobileChannel`), no global, y solo existe porque estas rutas no aceptan credenciales ambientales.
 *  - La identidad sale del token de acceso LIGADO a la clave del dispositivo: `Authorization: DPoP <token>` + cabecera `DPoP` con una
 *    prueba firmada (htm, htu, iat, jti unico, ath). Sin la clave privada, un token robado no sirve.
 *  - La proteccion contra repeticion (jti) y los nonces viven en PostgreSQL, compartidos entre instancias y vigentes tras un reinicio.
 *    Si esa base no responde, la peticion se RECHAZA (503): nunca se acepta sin poder comprobar la repeticion.
 *  - Nunca se acepta el token en la URL ni en el cuerpo (salvo el token de RENOVACION, que va en el cuerpo y siempre con prueba).
 *  - El actor, el rol y el alcance los decide el servidor desde la base; el cliente no los elige.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorBody } from '../auth/guards.js';
import { verifyDpopProof, type EcPublicJwk, type ProofResult } from './dpop.js';
import type {
  AccessFailure,
  MobileAuthConfig,
  MobileAuthService,
  MobileIdentity,
  ProofScope,
} from './mobile-auth.service.js';
import type { VerifiedSession } from '../auth/session-service.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Ruta del canal movil: no usa cookies, por lo que queda fuera de la comprobacion de Origin del navegador. */
    mobileChannel?: boolean;
  }
  interface FastifyRequest {
    /** Prueba DPoP verificada (rutas de enrolamiento y de emision de tokens). */
    deviceProof?: { thumbprint: string; jwk: EcPublicJwk };
    /** Contexto movil de una peticion autenticada. */
    mobile?: MobileIdentity;
  }
}

export interface MobileGuardsOptions {
  service: MobileAuthService;
  config: MobileAuthConfig;
  clock?: () => Date;
}

/** A que debe estar ligada la clave de la prueba antes de que pueda dejar estado en la base (ver ProofScope). */
export type ProofScopeFor = 'request' | 'device' | 'known_key';

const requestIdParam = z.object({ id: z.uuid() });

const headerOne = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export function createMobileGuards({ service, config, clock }: MobileGuardsOptions) {
  const nowMs = () => (clock ? clock().getTime() : Date.now());
  const urlOf = (request: FastifyRequest) => `${config.publicBaseUrl}${request.url.split('?')[0]}`;
  const skewMs = config.proofSkewSeconds * 1000;

  const unauthenticated = (
    request: FastifyRequest,
    reply: FastifyReply,
    code = 'UNAUTHENTICATED',
    message = 'Credenciales no válidas',
  ) =>
    reply
      .header('WWW-Authenticate', `DPoP error="invalid_token"`)
      .code(401)
      .send(errorBody(code, message, request.id));

  const tooManyProofs = (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Retry-After', String(config.proofSkewSeconds));
    return reply
      .code(429)
      .send(errorBody('RATE_LIMITED', 'Demasiadas pruebas. Intente más tarde.', request.id));
  };

  /** Respuesta uniforme cuando la base de seguridad compartida no responde: se RECHAZA (falla cerrado), sin detalles internos. */
  const unavailable = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    request.log.error(
      { code: (error as { code?: string } | null)?.code ?? 'unknown' },
      'estado anti-replay no disponible: peticion rechazada',
    );
    return reply
      .code(503)
      .send(
        errorBody(
          'MOBILE_AUTH_UNAVAILABLE',
          'La autenticación móvil no está disponible',
          request.id,
        ),
      );
  };

  /** Rechaza peticiones con `Origin` (propias de navegadores) y marca la respuesta como no almacenable. */
  const channelGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.origin !== undefined) {
      return reply
        .code(403)
        .send(
          errorBody('MOBILE_CHANNEL_ONLY', 'Este canal no se usa desde un navegador', request.id),
        );
    }
  };

  /**
   * Verifica la prueba DPoP SIN token de acceso y la ADMITE en el estado compartido (PostgreSQL). Orden deliberado, del mas barato al
   * mas caro y SIN dejar estado antes de conocer la clave:
   *   1. forma, firma y reclamos (CPU, sin estado);
   *   2. la clave debe estar ligada a una solicitud o a un dispositivo existente (`scope`);
   *   3. cupo por clave y rechazo atomico de la repeticion (UNIQUE jkt + jti);
   *   4. si la operacion lo exige, un nonce de la clave de UN solo uso.
   * Una clave generada al vuelo por una persona anonima se rechaza en el paso 2 y no consume cupo de nadie.
   * `requireNonce` es una regla de la OPERACION de negocio (activar, abrir o renovar sesion), no del protocolo: ver el ADR 0005.
   */
  const proofGuard =
    (opts: { requireNonce: boolean; scope: ProofScopeFor }) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      let scope: ProofScope;
      if (opts.scope === 'request') {
        const p = requestIdParam.safeParse(request.params);
        if (!p.success)
          return reply
            .code(400)
            .send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
        scope = { kind: 'request', requestId: p.data.id };
      } else {
        scope = { kind: opts.scope };
      }
      const result: ProofResult = verifyDpopProof(headerOne(request.headers['dpop']), {
        method: request.method,
        url: urlOf(request),
        nowMs: nowMs(),
        skewMs,
        requireNonce: opts.requireNonce,
      });
      if (!result.ok) {
        request.log.warn({ reason: result.reason }, 'prueba DPoP rechazada');
        if (result.reason === 'bad_nonce')
          return unauthenticated(request, reply, 'NONCE_INVALID', 'Solicite un nuevo desafío');
        return unauthenticated(request, reply, 'INVALID_PROOF', 'Prueba de posesión no válida');
      }
      let admission;
      try {
        admission = await service.admitProof({
          thumbprint: result.thumbprint,
          jti: result.jti,
          nonce: opts.requireNonce ? result.nonce : null,
          scope,
        });
      } catch (error) {
        return unavailable(request, reply, error);
      }
      if (!admission.ok) {
        request.log.warn({ reason: admission.reason }, 'prueba DPoP no admitida');
        if (admission.reason === 'unknown_key') {
          if (scope.kind === 'request')
            return reply
              .code(404)
              .send(errorBody('REQUEST_NOT_FOUND', 'Solicitud no encontrada', request.id));
          if (scope.kind === 'device')
            return unauthenticated(request, reply, 'UNKNOWN_DEVICE', 'Dispositivo no registrado');
        }
        if (admission.reason === 'rate_limited') return tooManyProofs(request, reply);
        if (admission.reason === 'bad_nonce')
          return unauthenticated(request, reply, 'NONCE_INVALID', 'Solicite un nuevo desafío');
        return unauthenticated(request, reply, 'INVALID_PROOF', 'Prueba de posesión no válida');
      }
      request.deviceProof = { thumbprint: result.thumbprint, jwk: result.jwk };
    };

  const FAILURE_BODY: Record<AccessFailure, [string, string]> = {
    invalid_token: ['UNAUTHENTICATED', 'Credenciales no válidas'],
    wrong_key: ['UNAUTHENTICATED', 'Credenciales no válidas'],
    token_expired: ['TOKEN_EXPIRED', 'El token de acceso venció: renueve la sesión'],
    session_expired: ['SESSION_ENDED', 'La sesión móvil terminó'],
    session_revoked: ['SESSION_ENDED', 'La sesión móvil terminó'],
    device_revoked: ['DEVICE_REVOKED', 'El dispositivo fue revocado'],
    not_eligible: ['UNAUTHENTICATED', 'Credenciales no válidas'],
    password_change_required: [
      'PASSWORD_CHANGE_REQUIRED',
      'Debe cambiar su contraseña en el portal',
    ],
    replay: ['INVALID_PROOF', 'Prueba de posesión no válida'],
    proof_limit: ['RATE_LIMITED', 'Demasiadas pruebas. Intente más tarde.'],
  };

  /**
   * Autentica una peticion movil: `Authorization: DPoP <token>` + prueba DPoP con `ath`. Deja `request.auth` con la MISMA forma que
   * una sesion web verificada (los servicios de dominio no distinguen canales) pero con los grants LIMITADOS a los permisos moviles.
   * La prueba solo se registra (anti-replay compartido) cuando token y clave ya corresponden a una sesion vigente de ESE dispositivo.
   */
  const accessGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = headerOne(request.headers.authorization);
    const match = authorization ? /^DPoP ([A-Za-z0-9_-]{43})$/.exec(authorization) : null;
    if (!match) return unauthenticated(request, reply);
    const token = match[1]!;
    const result = verifyDpopProof(headerOne(request.headers['dpop']), {
      method: request.method,
      url: urlOf(request),
      nowMs: nowMs(),
      skewMs,
      accessToken: token,
    });
    if (!result.ok) {
      request.log.warn({ reason: result.reason }, 'prueba DPoP rechazada');
      return unauthenticated(request, reply, 'INVALID_PROOF', 'Prueba de posesión no válida');
    }
    let verified;
    try {
      verified = await service.verifyAccess(token, result.thumbprint, result.jti);
    } catch (error) {
      return unavailable(request, reply, error);
    }
    if (!verified.ok) {
      if (verified.reason === 'replay' || verified.reason === 'proof_limit')
        request.log.warn({ reason: verified.reason }, 'prueba DPoP no admitida');
      if (verified.reason === 'proof_limit') return tooManyProofs(request, reply);
      const [code, message] = FAILURE_BODY[verified.reason];
      return unauthenticated(request, reply, code, message);
    }
    const id = verified.identity;
    const auth: VerifiedSession & { token: string } = {
      session: {
        id: id.sessionId,
        userId: id.userId,
        clientType: 'android',
        createdAt: id.createdAt,
        expiresAt: id.sessionExpiresAt,
        idleExpiresAt: id.idleExpiresAt,
        mfaVerifiedAt: null,
      },
      user: { id: id.userId, accountDomain: 'school', mustChangePassword: false },
      roles: id.roles,
      grants: id.grants,
      policy: {
        sessionIdleMinutes: Math.round(config.idleTtlSeconds / 60),
        sessionAbsoluteMinutes: Math.round(config.absoluteTtlSeconds / 60),
      },
      // El canal movil no tiene segundo factor: lo exige el servidor (las cuentas con roles que lo requieren no son elegibles).
      mfa: { required: false, enforced: true, verified: false },
      token,
    };
    request.auth = auth;
    request.mobile = id;
  };

  return { channelGuard, proofGuard, accessGuard, urlOf };
}

export type MobileGuards = ReturnType<typeof createMobileGuards>;
