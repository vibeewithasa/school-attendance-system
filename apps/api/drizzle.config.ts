import { defineConfig } from 'drizzle-kit';

// Las credenciales vienen del entorno (.env local, nunca versionado).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'eta15_dev',
    user: process.env.DB_USER ?? 'eta15_app',
    password: process.env.DB_PASSWORD,
    ssl: false,
  },
});
