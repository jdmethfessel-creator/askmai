"use client";

/**
 * Three-mode toggle for the creator page: Shop (try-on grid),
 * Ask (chat), Room (Dressing Room — user's saved items + looks).
 * State lives in the URL as ?mode=shop|ask|room so the selection
 * is shareable and survives reload. The active mode is passed in
 * from the server component which already read searchParams; this
 * component only emits the change.
 *
 * Why router.replace instead of push: a mode flip isn't a page
 * navigation in the user's mental model, so pushing onto the
 * history stack would mean "Back" trips through each toggle.
 * replace keeps the back button pointing at where they came from.
 *
 * scroll:false keeps the user in place when switching modes.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

export type Mode = "shop" | "ask" | "room";

// Display labels are decoupled from the URL `mode` value. The route
// value stays "room" (shareable URLs in the wild already use it);
// the visible label is "Dressing Room" because the user-facing
// concept reads better than a one-word tab.
const TABS: { mode: Mode; label: string }[] = [
  { mode: "shop", label: "Shop" },
  { mode: "ask", label: "Ask" },
  { mode: "room", label: "Dressing Room" },
];

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
      {TABS.map((t) => (
        <button
          key={t.mode}
          type="button"
          role="tab"
          aria-selected={current === t.mode}
          className={`tryon-mode-btn ${current === t.mode ? "is-active" : ""}`}
          onClick={() => setMode(t.mode)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
