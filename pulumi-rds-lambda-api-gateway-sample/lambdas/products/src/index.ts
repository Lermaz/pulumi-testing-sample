import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { query } from "./db";

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = "id, name, description, price_cents, stock, created_at, updated_at";

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
    return { name: name.trim(), description, price_cents, stock };
}

export const create = wrap(async (event) => {
    const p = parseProduct(event);
    const { rows } = await query(
        `INSERT INTO products (name, description, price_cents, stock) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
        [p.name, p.description, p.price_cents, p.stock]);
    return json(201, rows[0]);
});

export const list = wrap(async (event) => {
    const limit = Math.min(Number(event.queryStringParameters?.limit ?? 50) || 50, 100);
    const offset = Math.max(Number(event.queryStringParameters?.offset ?? 0) || 0, 0);
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM products ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`, [limit, offset]);
    return json(200, { items: rows, limit, offset });
});

export const get = wrap(async (event) => {
    const { rows } = await query(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [productId(event)]);
    return rows[0] ? json(200, rows[0]) : json(404, { error: "Product not found" });
});

export const update = wrap(async (event) => {
    const id = productId(event);
    const p = parseProduct(event);
    const { rows } = await query(
        `UPDATE products SET name = $2, description = $3, price_cents = $4, stock = $5, updated_at = now()
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, p.name, p.description, p.price_cents, p.stock]);
    return rows[0] ? json(200, rows[0]) : json(404, { error: "Product not found" });
});

export const remove = wrap(async (event) => {
    const { rowCount } = await query(`DELETE FROM products WHERE id = $1`, [productId(event)]);
    return rowCount ? json(204) : json(404, { error: "Product not found" });
});
