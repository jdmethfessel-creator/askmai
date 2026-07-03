"use client";

/**
 * Pull-sheet tabs for the creator page. Mirrors the ModeToggle
 * shape (URL-backed ?mode=shop|ask|room) but renders with the
 * pull-sheet visual system: uppercase tracked labels on a 1.5px
 * ink baseline, active tab as a 1.5px ink border box.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

export type Mode = "shop" | "ask" | "room";

const TABS: { mode: Mode; label: string }[] = [
  { mode: "shop", label: "Shop" },
  { mode: "ask", label: "Ask" },
  { mode: "room", label: "Try On" },
];

export default function PullSheetTabs({ current }: { current: Mode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  function setMode(next: Mode) {
    if (next === current) return;
    const sp = new URLSearchParams(params?.toString() ?? "");
    sp.set("mode", next);
    startTransition(() => {
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    });
  }

  return (
    <div className="ps-tabs" role="tablist" aria-label="Creator page mode">
      {TABS.map((t) => (
        <button
          key={t.mode}
          type="button"
          role="tab"
          className="ps-tab"
          aria-selected={current === t.mode}
          onClick={() => setMode(t.mode)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
