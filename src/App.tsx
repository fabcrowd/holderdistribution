import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ScrollToTop } from "@/components/ScrollToTop";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Loader2 } from "lucide-react";

// Single-route extraction of the original hub's Holders/Tokenomics section.
// The full hub had many pages; this repo deploys just this one, so there is
// only one lazy-loaded route rather than the original app's route table.
const Holders = lazy(() => import("./pages/Holders"));
const NotFound = lazy(() => import("./pages/NotFound"));

const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center" role="status" aria-live="polite">
    <Loader2 className="h-8 w-8 text-primary animate-spin" aria-hidden="true" />
    <span className="sr-only">Loading…</span>
  </div>
);

// The data feeds are static JSON refreshed by a scheduled pipeline, so a short
// stale window avoids refetch storms on tab focus while still picking up new
// snapshots; retries are bounded so a dead feed surfaces its error state fast.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <BrowserRouter>
        <ScrollToTop />
        <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Holders />} />
              <Route path="/holders" element={<Holders />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
