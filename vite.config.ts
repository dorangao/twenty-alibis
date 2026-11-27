import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { noModel } from "./src/game/terminal";
import { loadLibrary } from "./src/web/library";
import { nodeListener } from "./src/web/node";
import { memorySessions } from "./src/web/sessions";

/**
 * The dev server serves the page and the game API together.
 *
 * The model is off here, always: `npm run dev` sends nothing and spends nothing. A topic from
 * the menu gives the statement worded by code; a question in the player's own words says it
 * needs the model. The library is the handwritten case plus any case files in
 * cases/generated/ on this machine (they are not in the repository).
 */
function gameApi(): Plugin {
  return {
    name: "twenty-alibis-api",
    configureServer(server) {
      const { cases, skipped } = loadLibrary("cases/generated");
      if (skipped.length > 0) console.log(`cases left out (they did not pass the gate): ${skipped.join(", ")}`);
      const listener = nodeListener({ cases, sessions: memorySessions(), metered: noModel, modelOff: true });
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        void listener(req, res).catch(next);
      });
    },
  };
}

export default defineConfig({
  root: "web",
  plugins: [react(), gameApi()],
  server: { port: 5173, strictPort: false },
  build: { outDir: "dist", emptyOutDir: true },
});
