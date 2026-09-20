import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()],
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
    include: ["src/**/*.test.ts", "scripts/**/*.test.js"],
  },
}));
