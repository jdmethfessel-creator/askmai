"use client";

/**
 * Nav-bar auth affordance.
 *
 *   Signed-out: a "Log in" button that opens the SignInModal.
 *   Signed-in:  a small "Signed in" pill (passive — no menu yet).
 *
 * Used on both the marketing homepage nav and the creator-page top
 * bar. The button's visual treatment is provided by the parent via
 * `className` so the same component can wear the dark-landing chip
 * style or the lighter creator-page chip style without forking.
 */

import { useState } from "react";
import SignInModal from "./SignInModal";

export default function NavAuth({
  signedIn,
  className,
  signedInClassName,
  modalAccent,
}: {
  signedIn: boolean;
  className?: string;
  signedInClassName?: string;
  modalAccent?: string;
}) {
  const [open, setOpen] = useState(false);

  if (signedIn) {
    return (
      <span
        className={signedInClassName ?? className}
        aria-label="Signed in"
        title="Signed in"
      >
        Signed in
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className}
      >
        Log in
      </button>
      {open && (
        <SignInModal
          onClose={() => setOpen(false)}
          accent={modalAccent}
        />
      )}
    </>
  );
}
