import * as path from "path";
import { buildSync } from "esbuild";

/**
 * Bundles <dir>/src/index.ts into <dir>/dist/index.js so `pulumi preview/up`
 * never ships a stale or missing build. Returns the dist directory.
 */
export function bundleLambda(dir: string): string {
    const outDir = path.join(dir, "dist");
    buildSync({
        entryPoints: [path.join(dir, "src", "index.ts")],
        outfile: path.join(outDir, "index.js"),
        bundle: true,
        platform: "node",
        target: "node22",
        format: "cjs",
        minify: true,
        sourcemap: true,
        external: ["@aws-sdk/*", "pg-native"], // AWS SDK v3 ships with the Lambda runtime
        logLevel: "warning",
    });
    return outDir;
}
