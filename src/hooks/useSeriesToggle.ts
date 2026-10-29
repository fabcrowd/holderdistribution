import { useCallback, useMemo, useState } from "react";
import { normalizeHidden, toggleHidden } from "@/lib/chartZoom";

/** Which series are hidden; at least one always stays visible. */
export const useSeriesToggle = (allKeys: readonly string[]) => {
  const sig = allKeys.join("|");
  const [hiddenRaw, setHidden] = useState<ReadonlySet<string>>(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hidden = useMemo(() => normalizeHidden(hiddenRaw, allKeys), [hiddenRaw, sig]);
  const toggle = useCallback(
    (key: string) => setHidden((h) => toggleHidden(normalizeHidden(h, allKeys), key, allKeys)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  );
  const isVisible = useCallback((key: string) => !hidden.has(key), [hidden]);
  return { hidden, toggle, isVisible };
};
