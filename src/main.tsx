import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { reloadOnceForChunkError } from "./lib/chunkReload";

// Vite fires this when a modulepreload / dynamic import fails (stale tab after
// a deploy). preventDefault stops the error from propagating once we reload.
window.addEventListener("vite:preloadError", (event) => {
  const payload = (event as Event & { payload?: unknown }).payload ?? new Error("Failed to fetch dynamically imported module");
  if (reloadOnceForChunkError(payload instanceof Error ? payload : new Error("Failed to fetch dynamically imported module"))) {
    event.preventDefault();
  }
});

createRoot(document.getElementById("root")!).render(<App />);
