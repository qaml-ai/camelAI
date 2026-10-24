import { createElement } from "react";
import { createMemoryRouter, RouterProvider, useRevalidator } from "react-router";
import { render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettledFetcherResult } from "@/hooks/use-settled-fetcher-result";

describe("provider result revalidation", () => {
  it("does not replay retained success when revalidation changes the handler", () => {
    const revalidate = vi.fn();
    const first = { success: true };
    const { rerender } = renderHook(({ state, data }) => {
      // useRevalidator changes with loading/idle state, recreating this handler.
      useSettledFetcherResult(state, data, () => revalidate());
    }, { initialProps: { state: "idle", data: first } });
    for (let i = 0; i < 20; i++) rerender({ state: "idle", data: first });
    expect(revalidate).toHaveBeenCalledTimes(1);
    rerender({ state: "submitting", data: first });
    rerender({ state: "loading", data: { success: true } });
    expect(revalidate).toHaveBeenCalledTimes(1);
    rerender({ state: "idle", data: { success: true } });
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("stops after one reload with React Router's actual revalidator", async () => {
    const data = { success: true };
    const loader = vi.fn(() => ({}));
    function Page() {
      const revalidator = useRevalidator();
      useSettledFetcherResult("idle", data, () => { void revalidator.revalidate(); });
      return null;
    }
    const router = createMemoryRouter([{ path: "/", loader, element: createElement(Page) }]);
    const mounted = render(createElement(RouterProvider, { router }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(router.state.revalidation).toBe("idle"));
    expect(loader).toHaveBeenCalledTimes(2);
    mounted.unmount();
    router.dispose();
  });

  it("consumes failures once too, and waits for an idle result", () => {
    const onResult = vi.fn();
    const data = { error: "busy" };
    const { rerender } = renderHook(({ state }) => useSettledFetcherResult(state, data, onResult), {
      initialProps: { state: "loading" },
    });
    expect(onResult).not.toHaveBeenCalled();
    rerender({ state: "idle" });
    rerender({ state: "idle" });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(data);
  });
});
