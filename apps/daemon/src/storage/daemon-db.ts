export type DaemonDbKind = 'sqlite' | 'postgres';
export type PgSslMode = 'disable' | 'require' | 'verify-full';

export interface SqliteDaemonDbConfig {
  kind: 'sqlite';
}

export interface PostgresDaemonDbConfig {
  kind: 'postgres';
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    sslMode: PgSslMode;
    poolMax: number;
    schema?: string;
  };
}

/** Deliberately contains no password or connection string. */
export type DaemonDbConfig = SqliteDaemonDbConfig | PostgresDaemonDbConfig;

export class DaemonDbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonDbConfigError';
  }
}

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new DaemonDbConfigError(`${name} is required when OD_DAEMON_DB=postgres`);
  return value;
}

function integer(value: string | undefined, name: string, fallback: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new DaemonDbConfigError(`${name} must be an integer between 1 and ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new DaemonDbConfigError(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

export function resolveDaemonDbConfig(
  env: Record<string, string | undefined> = process.env,
): DaemonDbConfig {
  const kind = (env.OD_DAEMON_DB ?? 'sqlite').trim().toLowerCase();
  if (kind === '' || kind === 'sqlite') return { kind: 'sqlite' };
  if (kind !== 'postgres') {
    throw new DaemonDbConfigError('OD_DAEMON_DB must be either sqlite or postgres');
  }

  const sslMode = (env.OD_PG_SSL_MODE ?? 'require').trim().toLowerCase();
  if (sslMode !== 'disable' && sslMode !== 'require' && sslMode !== 'verify-full') {
    throw new DaemonDbConfigError('OD_PG_SSL_MODE must be disable, require, or verify-full');
  }

  const schema = env.OD_PG_SCHEMA?.trim();
  if (schema !== undefined && schema !== '' && !POSTGRES_IDENTIFIER.test(schema)) {
    throw new DaemonDbConfigError('OD_PG_SCHEMA must be a valid PostgreSQL identifier');
  }

  return {
    kind: 'postgres',
    postgres: {
      host: required(env, 'OD_PG_HOST'),
      port: integer(env.OD_PG_PORT, 'OD_PG_PORT', 5432, 65_535),
      database: required(env, 'OD_PG_DATABASE'),
      user: required(env, 'OD_PG_USER'),
      sslMode,
      poolMax: integer(env.OD_PG_POOL_MAX, 'OD_PG_POOL_MAX', 10, 10_000),
      ...(schema ? { schema } : {}),
    },
  };
}
