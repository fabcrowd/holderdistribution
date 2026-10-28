import { useEffect } from "react";
import { Link } from "react-router-dom";

/** Unknown paths: a real "not found" page that search engines won't index. */
const NotFound = () => {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Page not found | Holder Analytics";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    const prev = meta?.getAttribute("content") ?? null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "robots");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", "noindex, nofollow");
    return () => {
      document.title = prevTitle;
      if (created) meta?.remove();
      else if (prev !== null) meta?.setAttribute("content", prev);
    };
  }, []);
  return (
    <main id="main-content" className="flex min-h-screen items-center justify-center bg-background px-4" data-testid="not-found">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">404</p>
        <h1 className="mt-2 text-2xl font-bold text-foreground">Page not found</h1>
        <p className="mt-3 text-muted-foreground">There&apos;s nothing at this address. Pick a token on the home page.</p>
        <Link
          to="/"
          className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Go to home
        </Link>
      </div>
    </main>
  );
};

export default NotFound;
