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

import Link from "next/link";
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
    // Signed-in pill links to /profile so the profile page is
    // reachable from any nav surface. Inherits the same styling
    // class as the passive pill; only behavior change is href.
    return (
      <Link
        href="/profile"
        className={signedInClassName ?? className}
        style={{ textDecoration: "none" }}
        aria-label="Profile"
        title="Profile"
      >
        Profile
      </Link>
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
