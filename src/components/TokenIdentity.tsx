import { Link } from "react-router-dom";
import { useProject } from "@/hooks/useProject";

type Props = {
  /** "sm": desktop terminal title bar. "lg": the mobile page heading. */
  size?: "sm" | "lg";
  /** Mark only, for compact toolbars; the name stays available as the link's label. */
  iconOnly?: boolean;
  className?: string;
};

/**
 * Which token is open: its cached CoinGecko image (public/tokens/) and display
 * name. The whole mark links home to the token picker; there is no switcher.
 */
export const TokenIdentity = ({ size = "sm", iconOnly = false, className = "" }: Props) => {
  const { project } = useProject();
  const px = size === "lg" ? 32 : iconOnly ? 28 : 24;
  const imageSize = size === "lg" ? "h-7 w-7 sm:h-8 sm:w-8" : iconOnly ? "h-7 w-7" : "h-6 w-6";
  return (
    <Link
      to="/"
      data-testid="token-identity"
      title="All tokens"
      aria-label={iconOnly ? project.name : undefined}
      className={`inline-flex items-center gap-1.5 rounded text-primary hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {project.image && (
        <img
          src={project.image}
          alt=""
          width={px}
          height={px}
          decoding="async"
          className={`shrink-0 rounded-full ${imageSize}`}
        />
      )}
      {!iconOnly && <span className="truncate">{project.name}</span>}
    </Link>
  );
};

export default TokenIdentity;
