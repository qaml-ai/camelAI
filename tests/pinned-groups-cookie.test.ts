import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PINNED_GROUPS_COOKIE_NAME,
  readPinnedGroupCountHint,
  writePinnedGroupCountHint,
} from "@/lib/pinned-groups-cookie";

function clearPinnedGroupsCookie() {
  document.cookie = `${PINNED_GROUPS_COOKIE_NAME}=; path=/; max-age=0`;
}

function currentPinnedCookieValue(): string | undefined {
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PINNED_GROUPS_COOKIE_NAME}=`))
    ?.slice(PINNED_GROUPS_COOKIE_NAME.length + 1);
}

describe("pinned group count cookie", () => {
  beforeEach(() => {
    clearPinnedGroupsCookie();
    vi.restoreAllMocks();
  });

  it("returns zero for absent or malformed values and clamps counts", () => {
    expect(readPinnedGroupCountHint(undefined, "workspace_1")).toBe(0);
    expect(readPinnedGroupCountHint("not-json", "workspace_1")).toBe(0);
    expect(
      readPinnedGroupCountHint(
        encodeURIComponent(
          JSON.stringify({ workspace_1: 99, workspace_2: -4 }),
        ),
        "workspace_1",
      ),
    ).toBe(20);
    expect(
      readPinnedGroupCountHint(
        JSON.stringify({ workspace_1: 99, workspace_2: -4 }),
        "workspace_2",
      ),
    ).toBe(0);
    expect(
      readPinnedGroupCountHint(
        JSON.stringify({ workspace_1: 3 }),
        "missing",
      ),
    ).toBe(0);
  });

  it("upserts workspace counts and skips an identical newest write", () => {
    writePinnedGroupCountHint("workspace_1", 2);
    writePinnedGroupCountHint("workspace_2", 4);

    const cookieValue = currentPinnedCookieValue();
    expect(readPinnedGroupCountHint(cookieValue, "workspace_1")).toBe(2);
    expect(readPinnedGroupCountHint(cookieValue, "workspace_2")).toBe(4);

    const cookieSetter = vi.spyOn(document, "cookie", "set");
    writePinnedGroupCountHint("workspace_2", 4);
    expect(cookieSetter).not.toHaveBeenCalled();
  });

  it("moves updated workspaces to the end and prunes beyond eight entries", () => {
    for (let index = 1; index <= 8; index += 1) {
      writePinnedGroupCountHint(`workspace_${index}`, index);
    }
    writePinnedGroupCountHint("workspace_1", 1);
    writePinnedGroupCountHint("workspace_9", 9);

    const cookieValue = currentPinnedCookieValue();
    expect(readPinnedGroupCountHint(cookieValue, "workspace_1")).toBe(1);
    expect(readPinnedGroupCountHint(cookieValue, "workspace_2")).toBe(0);
    expect(readPinnedGroupCountHint(cookieValue, "workspace_9")).toBe(9);

    const decoded = JSON.parse(
      decodeURIComponent(cookieValue ?? "{}"),
    ) as Record<string, number>;
    expect(Object.keys(decoded)).toEqual([
      "workspace_3",
      "workspace_4",
      "workspace_5",
      "workspace_6",
      "workspace_7",
      "workspace_8",
      "workspace_1",
      "workspace_9",
    ]);
  });
});

describe("getCookie", () => {
  it("returns the URI-decoded value the pinned-groups hint is written with", async () => {
    const { getCookie } = await import("@/lib/cookies.server");
    const value = JSON.stringify({ workspace_1: 3 });
    const request = new Request("https://camelai.dev/", {
      headers: {
        Cookie: `sidebar_state=false; ${PINNED_GROUPS_COOKIE_NAME}=${encodeURIComponent(value)}; bad=%E0%A4%A`,
      },
    });
    expect(getCookie(request, PINNED_GROUPS_COOKIE_NAME)).toBe(value);
    expect(getCookie(request, "sidebar_state")).toBe("false");
    expect(getCookie(request, "bad")).toBe("%E0%A4%A");
    expect(getCookie(request, "missing")).toBeNull();
  });
});
