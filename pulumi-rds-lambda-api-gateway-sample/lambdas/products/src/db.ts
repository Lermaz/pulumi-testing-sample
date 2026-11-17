import * as path from "path";
import { Pool } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

const secrets = new SecretsManagerClient({});
const MIGRATION_LOCK_ID = 727274; // arbitrary constant: serializes concurrent cold starts
let dbPromise: Promise<Db> | undefined;

function env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var ${name}`);
    return v;
}

async function createDb(): Promise<Db> {
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

    // Apply pending migrations (bundled next to index.js by lib/bundle.ts) under an advisory lock.
    const client = await pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
        await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "drizzle") });
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
        client.release();
    }

    return drizzle(pool, { schema });
}

function getDb(): Promise<Db> {
    dbPromise ??= createDb().catch(err => {
        dbPromise = undefined; // don't cache a failed init
        throw err;
    });
    return dbPromise;
}

const isBadPassword = (err: any) => (err?.code ?? err?.cause?.code) === "28P01"; // Drizzle wraps pg errors in .cause

/** Runs `fn` with the Drizzle client; if RDS rotated the password, refetch the secret and retry once. */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    try {
        return await fn(await getDb());
    } catch (err) {
        if (!isBadPassword(err)) throw err;
        dbPromise = undefined;
        return fn(await getDb());
    }
}
