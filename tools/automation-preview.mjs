// Serve the actual production bundle with the real isolated API, without API mocks.
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const frontend = path.join(root, "src/frontend");
const require = createRequire(path.join(frontend, "package.json"));
const { preview } = await import(pathToFileURL(require.resolve("vite")).href);
const server = await preview({
  root: frontend,
  configFile: path.join(frontend, "vite.config.ts"),
  preview: {
    host: "127.0.0.1",
    port: 5184,
    strictPort: true,
    open: false,
    proxy: { "/api": { target: "http://127.0.0.1:5801", changeOrigin: false } },
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.httpServer.close(() => process.exit(0)));
}
