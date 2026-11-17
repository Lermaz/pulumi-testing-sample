import * as path from "path";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../lambdas/products/src/schema";
import { create, get, list, remove, update } from "../lambdas/products/src/index";

// Handlers run their REAL Drizzle queries against an in-memory Postgres (PGlite),
// built from the same SQL migrations that ship to RDS. Only the connection layer is replaced.
const state = vi.hoisted(() => ({ db: undefined as unknown, failWith: undefined as Error | undefined }));

vi.mock("../src/db", () => ({
    withDb: async (fn: (db: unknown) => Promise<unknown>) => {
        if (state.failWith) throw state.failWith;
        return fn(state.db);
    },
}));

type Event = Partial<APIGatewayProxyEventV2>;
type Handler = (e: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

async function call(handler: Handler, event: Event = {}) {
    const res = (await handler(event as APIGatewayProxyEventV2)) as { statusCode: number; body?: string };
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

const body = (o: unknown): Event => ({ body: JSON.stringify(o) });
const withId = (id: string, e: Event = {}): Event => ({ ...e, pathParameters: { id } });
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

async function seed(name = "Mug", price_cents = 1200, extra: object = {}) {
    const res = await call(create, body({ name, price_cents, ...extra }));
    expect(res.status).toBe(201);
    return res.body;
}

beforeAll(async () => {
    const db = drizzle(new PGlite(), { schema });
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../lambdas/drizzle") });
    state.db = db;
});

beforeEach(async () => {
    await (state.db as ReturnType<typeof drizzle>).delete(schema.products);
});

describe("create", () => {
    it("returns 201 with a snake_case product and default stock", async () => {
        const { status, body: p } = await call(create, body({ name: "  Mug ", price_cents: 1200 }));
        expect(status).toBe(201);
        expect(p).toMatchObject({ name: "Mug", description: null, price_cents: 1200, stock: 0 });
        expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(p).toHaveProperty("created_at");
        expect(p).not.toHaveProperty("priceCents");
    });

    it.each([
        ["missing name", { price_cents: 100 }],
        ["blank name", { name: "  ", price_cents: 100 }],
        ["missing price", { name: "x" }],
        ["negative price", { name: "x", price_cents: -1 }],
        ["fractional price", { name: "x", price_cents: 1.5 }],
        ["negative stock", { name: "x", price_cents: 1, stock: -1 }],
        ["non-string description", { name: "x", price_cents: 1, description: 5 }],
    ])("rejects %s with 400", async (_label, payload) => {
        const { status, body: b } = await call(create, body(payload));
        expect(status).toBe(400);
        expect(b.error).toBeTruthy();
    });

    it("rejects invalid JSON and a missing body with 400", async () => {
        expect((await call(create, { body: "{nope" })).status).toBe(400);
        expect((await call(create, {})).status).toBe(400);
    });
});

describe("get", () => {
    it("returns an existing product", async () => {
        const p = await seed();
        const res = await call(get, withId(p.id));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: p.id, name: "Mug" });
    });

    it("404s for an unknown id and 400s for a malformed one", async () => {
        expect((await call(get, withId(UNKNOWN_ID))).status).toBe(404);
        expect((await call(get, withId("not-a-uuid"))).status).toBe(400);
        expect((await call(get, {})).status).toBe(400);
    });
});

describe("list", () => {
    it("returns newest first with default paging", async () => {
        await seed("A");
        await seed("B");
        const { status, body: b } = await call(list);
        expect(status).toBe(200);
        expect(b.items.map((p: any) => p.name)).toEqual(["B", "A"]);
        expect(b).toMatchObject({ limit: 50, offset: 0 });
    });

    it("applies limit and offset, and caps limit at 100", async () => {
        for (const n of ["A", "B", "C"]) await seed(n);
        const page = await call(list, { queryStringParameters: { limit: "1", offset: "1" } });
        expect(page.body.items.map((p: any) => p.name)).toEqual(["B"]);
        const capped = await call(list, { queryStringParameters: { limit: "5000" } });
        expect(capped.body.limit).toBe(100);
    });

    it("falls back to defaults for garbage paging values", async () => {
        const { body: b } = await call(list, { queryStringParameters: { limit: "abc", offset: "-5" } });
        expect(b).toMatchObject({ limit: 50, offset: 0 });
    });
});

describe("update", () => {
    it("replaces the fields and bumps updated_at", async () => {
        const p = await seed("Mug", 1200, { description: "old" });
        const res = await call(update, withId(p.id, body({ name: "Cup", price_cents: 900, stock: 7 })));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: p.id, name: "Cup", price_cents: 900, stock: 7, description: null });
        expect(new Date(res.body.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(p.updated_at).getTime());
    });

    it("404s for an unknown id and 400s for invalid input", async () => {
        const ok = body({ name: "x", price_cents: 1 });
        expect((await call(update, withId(UNKNOWN_ID, ok))).status).toBe(404);
        const p = await seed();
        expect((await call(update, withId(p.id, body({ name: "", price_cents: 1 })))).status).toBe(400);
        expect((await call(update, withId("nope", ok))).status).toBe(400);
    });
});

describe("remove", () => {
    it("deletes with 204 and the product is gone", async () => {
        const p = await seed();
        const res = await call(remove, withId(p.id));
        expect(res).toEqual({ status: 204, body: undefined });
        expect((await call(get, withId(p.id))).status).toBe(404);
    });

    it("404s for an unknown id", async () => {
        expect((await call(remove, withId(UNKNOWN_ID))).status).toBe(404);
    });
});

describe("error handling", () => {
    afterEach(() => { state.failWith = undefined; });

    it("returns a generic 500 and does not leak internals", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        state.failWith = new Error("password=hunter2 host=internal.rds");
        const res = await call(list);
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toMatch(/hunter2|internal/);
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });
});
