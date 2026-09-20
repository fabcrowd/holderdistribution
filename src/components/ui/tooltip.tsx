import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  // Without a Portal, Content renders in place in the React tree. That's
  // invisible-but-silent almost everywhere in this app (normal HTML flow
  // just gets an extra in-place node), but a trigger nested inside an <svg>
  // (e.g. TierFlowDiagram's flow-line tooltips) breaks completely: React
  // tracks SVG namespace by tree position, so an un-portaled div/span
  // rendered inside <svg> gets created via createElementNS(svg) — its
  // .className becomes an SVGAnimatedString instead of a string, normal CSS
  // box layout never applies, and it renders with zero width/height despite
  // correct text content and correctly computed Popper position. A real
  // Portal always mounts into the document (HTML namespace), which also
  // gives every OTHER Tooltip in the app the usual escape-clipping/z-index
  // benefit a portal is supposed to provide.
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
