import { Component, ErrorInfo, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { clearLocalUnlock } from "@/lib/localUnlock";
import { isChunkLoadError, reloadOnceForChunkError } from "@/lib/chunkReload";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Without this, a render-time exception anywhere in the route tree unmounts
// the whole app with nothing to catch it. All that's left visible is the
// hardcoded blue gradient on `body` in index.css — a silent blank page with
// no diagnostic trail. This boundary guarantees a real fallback instead.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // A stale tab after a deploy: its lazy chunk is gone. One reload fixes it.
    if (reloadOnceForChunkError(error)) return;
    console.error("Render error caught by ErrorBoundary:", error, errorInfo);
    // A crashed unlock (stale password, bad ledger payload) otherwise loops:
    // localStorage still holds the password, reload auto-unlocks, crash again.
    clearLocalUnlock();
  }

  render() {
    if (this.state.error) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-background">
          <div className="max-w-md px-4 text-center">
            <h1 className="mb-4 text-2xl font-bold text-foreground">
              {isChunkLoadError(this.state.error) ? "A newer version is available" : "Something went wrong"}
            </h1>
            <p className="mb-6 text-muted-foreground">
              {isChunkLoadError(this.state.error)
                ? "Part of the page couldn't be loaded, usually because the site was just updated. Reload to get the latest version."
                : "This page hit an unexpected error. Reloading usually fixes it."}
            </p>
            <Button onClick={() => window.location.reload()}>Reload page</Button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
