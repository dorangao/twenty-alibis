import { resolve } from "node:path";
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

const repo = import.meta.dirname;

export default defineConfig({
  root: "web",
  plugins: [react(), gameApi()],
  server: {
    port: 5173,
    strictPort: false,
    /**
     * What the dev server will hand out as a file. By default that is the whole checkout,
     * which holds the case files with their answers and the server's own source. A page, or
     * anyone who can reach this port, could then simply ask for a case file. So the server
     * is allowed the page's folder and the installed packages, nothing else, and the folders
     * that hold cases, traces, source and tests are named as denied on top of that.
     */
    fs: {
      strict: true,
      allow: [resolve(repo, "web"), resolve(repo, "node_modules")],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", ...["cases", "traces", "src", "test", "scripts"].map((dir) => `${repo}/${dir}/**`)],
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
