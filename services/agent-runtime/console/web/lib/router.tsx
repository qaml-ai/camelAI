import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

/** Paths are relative to /console/, e.g. "agents/client_abc". */
const BASE = "/console/";
const current = () => location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length).replace(/\/+$/, "") : "";

export function navigate(path: string) {
  history.pushState(null, "", BASE + path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath() {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const update = () => setPath(current());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return path;
}

export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return <a {...props} href={BASE + to} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  }} />;
}
