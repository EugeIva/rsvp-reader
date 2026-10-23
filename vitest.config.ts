import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";

export default defineConfig({
    // Compiles runes ($state) in .svelte.ts modules under test.
    plugins: [svelte()],
    resolve: {
        alias: {
            $lib: path.resolve("./src/lib"),
        },
    },
    test: {
        include: ["src/**/*.test.ts"],
    },
});
