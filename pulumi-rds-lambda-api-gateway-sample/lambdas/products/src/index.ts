import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { desc, eq } from "drizzle-orm";
import { withDb } from "./db";
import { Product, products } from "./schema";

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Drizzle uses camelCase; the public API keeps snake_case.
const toApi = (p: Product) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price_cents: p.priceCents,
    stock: p.stock,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
});

const json = (statusCode: number, body?: unknown): APIGatewayProxyResultV2 => ({
    statusCode,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
});

const wrap = (fn: Handler): Handler => async (event) => {
    try {
        return await fn(event);
    } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: err.message });
        console.error(JSON.stringify({ message: "unhandled error", error: String(err) }));
        return json(500, { error: "Internal server error" });
    }
};

function productId(event: APIGatewayProxyEventV2): string {
    const id = event.pathParameters?.id;
    if (!id || !UUID.test(id)) throw new HttpError(400, "id must be a UUID");
    return id;
}

function parseProduct(event: APIGatewayProxyEventV2) {
    let body: any;
    try { body = JSON.parse(event.body ?? ""); } catch { throw new HttpError(400, "Body must be valid JSON"); }
    const { name, description = null, price_cents, stock = 0 } = body ?? {};
    if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "name is required");
    if (!Number.isInteger(price_cents) || price_cents < 0) throw new HttpError(400, "price_cents must be an integer >= 0");
    if (!Number.isInteger(stock) || stock < 0) throw new HttpError(400, "stock must be an integer >= 0");
    if (description !== null && typeof description !== "string") throw new HttpError(400, "description must be a string");
    return { name: name.trim(), description, priceCents: price_cents as number, stock: stock as number };
}

export const create = wrap(async (event) => {
    const values = parseProduct(event);
    const [row] = await withDb(db => db.insert(products).values(values).returning());
    return json(201, toApi(row));
});

export const list = wrap(async (event) => {
    const limit = Math.min(Number(event.queryStringParameters?.limit ?? 50) || 50, 100);
    const offset = Math.max(Number(event.queryStringParameters?.offset ?? 0) || 0, 0);
    const rows = await withDb(db =>
        db.select().from(products).orderBy(desc(products.createdAt), products.id).limit(limit).offset(offset));
    return json(200, { items: rows.map(toApi), limit, offset });
});

export const get = wrap(async (event) => {
    const id = productId(event);
    const [row] = await withDb(db => db.select().from(products).where(eq(products.id, id)));
    return row ? json(200, toApi(row)) : json(404, { error: "Product not found" });
});

export const update = wrap(async (event) => {
    const id = productId(event);
    const values = parseProduct(event);
    const [row] = await withDb(db =>
        db.update(products).set({ ...values, updatedAt: new Date() }).where(eq(products.id, id)).returning());
    return row ? json(200, toApi(row)) : json(404, { error: "Product not found" });
});

export const remove = wrap(async (event) => {
    const id = productId(event);
    const deleted = await withDb(db =>
        db.delete(products).where(eq(products.id, id)).returning({ id: products.id }));
    return deleted.length ? json(204) : json(404, { error: "Product not found" });
});
