import type pg from "pg";
// The platform CA is optional when its chain is already trusted by Node.
// Query-string sslmode must not override the verified TLS options below.
export function postgresOptions(
  connectionString: string | undefined,
  production = true,
): pg.ClientConfig {
  if (!connectionString) throw new Error("Database connection is required");
  const url = new URL(connectionString);
  if (production) {
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  }
  return {
    connectionString: url.toString(),
    connectionTimeoutMillis: 10000,
    ...(production
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT } : {}),
          },
        }
      : {}),
  };
}
