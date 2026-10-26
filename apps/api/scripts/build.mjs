/**
 * Compilacion de la API: comprueba tipos con tsc y empaqueta `src/server.ts` en `dist/server.js` con esbuild.
 *
 * Por que se empaqueta: `@eta15/shared-contracts` es un paquete del monorepo cuyo codigo fuente es TypeScript (contratos Zod
 * y utilidades compartidas con la web). Node no ejecuta TypeScript de un paquete enlazado, asi que ese paquete se incluye en
 * el empaquetado; las dependencias externas (fastify, pg, zod, ...) se resuelven en tiempo de ejecucion desde node_modules.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import { build } from 'esbuild';

const typecheck = spawnSync(
  process.execPath,
  ['../../node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--noEmit'],
  {
    stdio: 'inherit',
  },
);
if (typecheck.status !== 0) process.exit(typecheck.status ?? 1);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
  (name) => !name.startsWith('@eta15/'),
);

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external,
  logLevel: 'info',
});
