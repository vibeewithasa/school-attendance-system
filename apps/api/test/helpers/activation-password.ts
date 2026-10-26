import { createPasswordService } from '../../src/modules/auth/password.js';

const verifier = createPasswordService({
  params: { memoryKiB: 20 * 1024, passes: 2, parallelism: 1, tagLength: 32 },
});

/** Verifica un hash Argon2id almacenado contra una contrasena (los parametros se leen del propio hash). */
export const verifyPasswordForTests = (hash: string, password: string) =>
  verifier.verify(hash, password);
