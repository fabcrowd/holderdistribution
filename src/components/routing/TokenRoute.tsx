import { Fragment, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { isProjectSlug } from "@/lib/projects";
import { getActiveSlug, setActiveSlug, subscribeActiveSlug } from "@/lib/projectStore";

type Props = { children: ReactNode; notFound: ReactNode };

/**
 * `/:slug` gate. Unknown slug → the 404 page. Known slug → sync the active
 * project store (before paint), then render the terminal keyed by slug so all
 * terminal state resets when the token changes. Until the store matches (one
 * layout-effect tick on a client-side slug change) it renders nothing, so no
 * feed hook ever fetches the previous token's data under the new URL.
 */
export const TokenRoute = ({ children, notFound }: Props) => {
  const { slug = "" } = useParams();
  const known = isProjectSlug(slug);
  const active = useSyncExternalStore(subscribeActiveSlug, getActiveSlug, getActiveSlug);
  useLayoutEffect(() => {
    if (known) setActiveSlug(slug);
  }, [known, slug]);
  if (!known) return <>{notFound}</>;
  if (active !== slug) return null;
  return <Fragment key={slug}>{children}</Fragment>;
};

export default TokenRoute;
