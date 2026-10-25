import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import type { Plugin } from "vite";
import { legacyRootSlugs } from "./scripts/lib/projects.js";

/**
 * Dev/preview only: serve /data/<slug>/<feed> for "legacyRoot" projects (TEL),
 * whose pipelines still write public/data/<feed>. Production gets the same
 * layout from scripts/prune-dist-data.js (postbuild copies into dist/data/<slug>/).
 */
const legacyProjectData = (): Plugin => {
  const slugs = new Set(legacyRootSlugs(__dirname));
  const handler = (req: { url?: string }, res: import("http").ServerResponse, next: () => void) => {
    const m = /^\/data\/([a-z0-9-]+)\/([a-z0-9.-]+\.json)(?:\?.*)?$/i.exec(req.url ?? "");
    if (!m || !slugs.has(m[1])) return next();
    const file = path.resolve(__dirname, "public/data", m[2]);
    if (!fs.existsSync(file) || fs.existsSync(path.resolve(__dirname, "public/data", m[1], m[2]))) return next();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: "legacy-project-data",
    configureServer(server) {
      server.middlewares.use(handler);
    },
  };
};

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), legacyProjectData()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Without this, Vite's default chunking bundles third-party code
        // together with whichever app module first imports it — e.g. the
        // entire @supabase/supabase-js SDK ended up inside a chunk named
        // after useHomeTiles.ts, so that chunk's hash (and cache) changed
        // on every deploy even when vendor code hadn't. Grouping stable
        // node_modules into vendor-* chunks keeps those hashes stable
        // across app-only deploys.
        //
        // Do NOT put react/react-dom/scheduler in their own chunk. Forcing
        // them into vendor-react left next-themes (catch-all vendor chunk)
        // calling createContext while its React import was still undefined
        // — blank #root / cyan body on production after #162.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (id.includes("@supabase")) return "vendor-supabase";
          if (id.includes("recharts") || id.includes("d3-")) return "vendor-charts";
          if (id.includes("react-router")) return "vendor-router";
          if (id.includes("@tanstack")) return "vendor-query";
          if (id.includes("date-fns")) return "vendor-date";
          if (id.includes("lucide-react")) return "vendor-icons";
          return "vendor";
        },
      },
    },
  },
  test: {
    environment: "node",
    globals: true,
    // `scripts/` is included too: the pipeline generators hold real logic
    // (flow attribution, rounding, rollups) and previously could not be
    // covered at all — a test file added there was silently never run.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.js", "netlify/**/*.test.ts"],
  },
}));
