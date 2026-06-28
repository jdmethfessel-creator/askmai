"use client";

/**
 * Two-mode toggle for the creator page: "Shop" (try-on grid) and
 * "Ask" (chat). State lives in the URL as ?mode=shop|ask so the
 * selection is shareable and survives reload. The active mode is
 * passed in from the server component which already read
 * searchParams; this component only emits the change.
 *
 * Why router.replace instead of push: a mode flip isn't a page
 * navigation in the user's mental model, so pushing onto the
 * history stack would mean "Back" trips through each toggle. replace
 * keeps the back button pointing at where they actually came from.
 *
 * scroll:false keeps the user in place when switching modes (the
 * default Next.js scroll-to-top would jolt them away from the
 * toggle itself).
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

export type Mode = "shop" | "ask";

export default function ModeToggle({ current }: { current: Mode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  function setMode(next: Mode) {
    if (next === current) return;
    const sp = new URLSearchParams(params?.toString() ?? "");
    sp.set("mode", next);
    const qs = sp.toString();
    startTransition(() => {
      router.replace(`${pathname}?${qs}`, { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Creator page mode"
      className="tryon-mode-toggle"
    >
      <button
        type="button"
        role="tab"
        aria-selected={current === "shop"}
        className={`tryon-mode-btn ${current === "shop" ? "is-active" : ""}`}
        onClick={() => setMode("shop")}
      >
        Shop
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={current === "ask"}
        className={`tryon-mode-btn ${current === "ask" ? "is-active" : ""}`}
        onClick={() => setMode("ask")}
      >
        Ask
      </button>
    </div>
  );
}
