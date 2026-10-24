import { useEffect, useRef } from "react";

/** Consume each action result once, even when its handler revalidates loaders. */
export function useSettledFetcherResult<T>(
  state: string,
  data: T | undefined,
  onResult: (data: T) => void,
): void {
  const consumed = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || data === undefined || data === consumed.current) return;
    // fetcher.data survives loading/idle transitions. Mark it before the
    // callback: revalidate() changes useRevalidator's object and reruns effects.
    consumed.current = data;
    onResult(data);
  }, [state, data, onResult]);
}
