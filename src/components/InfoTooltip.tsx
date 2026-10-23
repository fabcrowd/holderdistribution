import { InfoTip } from "@/components/InfoTip";

type InfoTooltipProps = {
  /** Explainer text. Use \n for paragraph breaks. */
  text: string;
  className?: string;
  /** Accessible name; defaults to "More information". */
  label?: string;
};

/**
 * Small inline "info" icon explaining how a metric is derived. Opens on
 * click / tap (pinned) and previews on hover — see InfoTip — with a 24px hit
 * area. Kept as a thin wrapper so existing call sites keep their API.
 */
export const InfoTooltip = ({ text, className, label }: InfoTooltipProps) => (
  <InfoTip content={text} label={label} className={`-my-1 ${className ?? ""}`} side="top" />
);
