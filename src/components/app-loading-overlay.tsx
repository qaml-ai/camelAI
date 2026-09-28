import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Full-screen loading overlay shown on the very first paint and removed once
 * the app has hydrated.
 *
 * It covers the gap between initial HTML paint and React hydration becoming
 * interactive — on a cold load the JS bundle can take a while to download and
 * parse, during which the SSR'd markup (often a skeleton) is visible but not
 * yet interactive. Rendering this in the document shell guarantees an
 * immediate "it's loading" signal.
 *
 * Client-side route transitions are handled separately by
 * `<NavigationProgress />`; this overlay only ever shows once and never
 * re-appears after the initial hydration.
 */
export function AppLoadingOverlay() {
  // SSR and the first client render both produce "visible" so hydration
  // matches; the effect (which only runs on the client, post-hydration)
  // starts the fade-out.
  const [phase, setPhase] = useState<"visible" | "fading" | "gone">("visible");

  useEffect(() => {
    setPhase("fading");
    const timeout = setTimeout(() => setPhase("gone"), 200);
    return () => clearTimeout(timeout);
  }, []);

  if (phase === "gone") return null;

  return (
    <div
      aria-hidden="true"
      data-app-loading-overlay=""
      className={cn(
        "pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-background",
        "transition-opacity duration-200",
        phase === "fading" ? "opacity-0" : "opacity-100",
      )}
    >
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}
