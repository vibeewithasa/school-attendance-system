import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createAuthGuards, DEV_COOKIE_NAME } from '../src/modules/auth/guards.js';
import type {
  MfaState,
  SessionService,
  VerifySessionResult,
} from '../src/modules/auth/session-service.js';

/** Puerta de MFA de las rutas administrativas: una sesion sin MFA verificado solo llega con el diferimiento local. */
const verified = (mfa: MfaState, mustChangePassword = false): VerifySessionResult => ({
  ok: true,
  session: {
    id: 's',
    userId: 'u',
    clientType: 'web',
    createdAt: new Date(),
    expiresAt: new Date(),
    idleExpiresAt: new Date(),
    mfaVerifiedAt: mfa.verified ? new Date() : null,
  },
  user: { id: 'u', accountDomain: 'school', mustChangePassword },
  roles: ['direccion'],
  grants: [],
  policy: { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 480 },
  mfa,
});

async function status(result: VerifySessionResult, mfaDeferredAllowed: boolean): Promise<number> {
  const sessions = { verify: async () => result } as unknown as SessionService;
  const guards = createAuthGuards({ sessions, production: false });
  const app = Fastify();
  await app.register(cookie);
  app.get('/x', { preHandler: guards.adminGuard(mfaDeferredAllowed) }, async () => ({ ok: true }));
  const res = await app.inject({
    method: 'GET',
    url: '/x',
    headers: { cookie: `${DEV_COOKIE_NAME}=${'A'.repeat(43)}` },
  });
  await app.close();
  return res.statusCode;
}

describe('adminGuard (puerta de MFA)', () => {
  const unverified: MfaState = { required: true, enforced: false, verified: false };

  it('sin MFA verificado y rol que lo exige: solo pasa con el diferimiento local permitido', async () => {
    expect(await status(verified(unverified), true)).toBe(200);
    expect(await status(verified(unverified), false)).toBe(403); // produccion: NUNCA llega al handler
  });

  it('con MFA verificado o sin rol que lo exija pasa siempre', async () => {
    expect(await status(verified({ required: true, enforced: true, verified: true }), false)).toBe(
      200,
    );
    expect(
      await status(verified({ required: false, enforced: true, verified: false }), false),
    ).toBe(200);
  });

  it('si el servidor impone MFA (enforced) una sesion sin verificar no pasa aunque se declare el diferimiento', async () => {
    expect(await status(verified({ required: true, enforced: true, verified: false }), true)).toBe(
      403,
    );
  });

  it('cambio de contrasena pendiente: 403 salvo rutas que lo permiten', async () => {
    expect(
      await status(verified({ required: false, enforced: true, verified: false }, true), false),
    ).toBe(403);
  });

  it('sesion invalida: 401', async () => {
    expect(await status({ ok: false, reason: 'revoked' }, true)).toBe(401);
  });
});
