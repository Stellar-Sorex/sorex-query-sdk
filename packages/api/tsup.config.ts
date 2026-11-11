import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
});
