import { defineConfig } from "vite";
export default defineConfig({ base: "./", server: { host: "127.0.0.1", port: 5179 }, test: { include: ["test/*.test.ts", "test/*.test.mjs"] } } as never);
