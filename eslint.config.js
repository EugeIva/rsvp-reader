import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

export default defineConfig(
    js.configs.recommended,
    ...ts.configs.recommended,
    ...svelte.configs.recommended,
    prettier,
    ...svelte.configs.prettier,
    {
        languageOptions: {
            globals: { ...globals.browser, ...globals.node },
        },
    },
    {
        files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                extraFileExtensions: [".svelte"],
                parser: ts.parser,
                svelteConfig,
            },
        },
        rules: {
            // Effects name the values they depend on with bare reads such as `$book;`.
            "@typescript-eslint/no-unused-expressions": "off",
        },
    },
    {
        ignores: ["build/", ".svelte-kit/", "node_modules/", "src-tauri/"],
    },
);
