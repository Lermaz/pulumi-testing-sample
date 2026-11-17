import { defineConfig } from "drizzle-kit";

// Used only to GENERATE migrations (`npm run db:generate`, run from the repo root);
// they are applied by the Lambda on cold start.
export default defineConfig({
    dialect: "postgresql",
    schema: "./lambdas/products/src/schema.ts",
    out: "./lambdas/products/drizzle",
});
