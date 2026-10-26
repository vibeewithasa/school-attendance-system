import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Clave primaria UUID v7 (uuidv7() nativo de PostgreSQL 18). */
export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

/** created_at / updated_at en timestamptz; updated_at lo mantiene el trigger set_updated_at (migracion 0001). */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** bytea como Buffer (hashes de tokens). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** xid8 (identificador de transaccion de 64 bits) como texto. */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/** inet como texto. */
export const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});
