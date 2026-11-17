import { Pool, QueryResult, QueryResultRow } from "pg";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});
let poolPromise: Promise<Pool> | undefined;

// NOTE: fine for getting started. Move to real migrations (e.g. node-pg-migrate) before prod.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS products (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    description text,
    price_cents integer NOT NULL CHECK (price_cents >= 0),
    stock       integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  )`;

function env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var ${name}`);
    return v;
}

async function createPool(): Promise<Pool> {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: env("DB_SECRET_ARN") }));
    const { username, password } = JSON.parse(res.SecretString ?? "{}");
    const pool = new Pool({
        host: env("DB_HOST"),
        port: Number(env("DB_PORT")),
        database: env("DB_NAME"),
        user: username,
        password,
        max: 1, // one connection per Lambda container
        connectionTimeoutMillis: 5000,
        // Encrypted but not CA-verified. TODO: bundle the RDS CA and set rejectUnauthorized: true.
        ssl: { rejectUnauthorized: false },
    });
    await pool.query(SCHEMA);
    return pool;
}

function getPool(): Promise<Pool> {
    poolPromise ??= createPool().catch(err => {
        poolPromise = undefined; // don't cache a failed init
        throw err;
    });
    return poolPromise;
}

/** Runs a query; if RDS rotated the password (28P01), refetch the secret and retry once. */
export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    try {
        return await (await getPool()).query<T>(text, params);
    } catch (err: any) {
        if (err?.code !== "28P01") throw err;
        poolPromise = undefined;
        return (await getPool()).query<T>(text, params);
    }
}
