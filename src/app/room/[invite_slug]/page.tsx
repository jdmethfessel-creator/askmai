/**
 * /room/[invite_slug] — Shared Fitting Room surface.
 *
 * Server component just resolves the invite slug and renders the
 * client shell. Everything else (join gate, submissions feed,
 * reactions, comments, host controls) lives in RoomClient so the
 * page can update over polling + realtime without a full navigation.
 */

import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabase";
import RoomClient from "./RoomClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { invite_slug: string };

async function loadRoomBasics(inviteSlug: string) {
  const clean = inviteSlug.trim().toUpperCase().slice(0, 32);
  if (!clean) return null;
  const admin = supabaseAdmin();
  const { data } = await admin
    .from("fitting_rooms")
    .select("name, creator_slug, is_archived")
    .eq("invite_slug", clean)
    .maybeSingle();
  return data as { name: string; creator_slug: string; is_archived: boolean } | null;
}

export async function generateMetadata(props: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const params = await props.params;
  const room = await loadRoomBasics(params.invite_slug);
  const title = room ? `${room.name} · fitting room` : "Fitting room · AskMai";
  return {
    title,
    description: "A shared fitting room on AskMai.",
    robots: { index: false, follow: false },
  };
}

export default async function RoomPage(props: { params: Promise<Params> }) {
  const params = await props.params;
  const room = await loadRoomBasics(params.invite_slug);

  if (!room) {
    return (
      <main className="room-page room-page-empty">
        <div className="room-empty-card">
          <h1>Room not found</h1>
          <p>This invite link is expired or the room was removed.</p>
          <a className="room-btn room-btn-primary" href="/">
            Go home
          </a>
        </div>
      </main>
    );
  }

  return (
    <RoomClient
      inviteSlug={params.invite_slug.toUpperCase()}
      initialName={room.name}
      creatorSlug={room.creator_slug}
      isArchived={room.is_archived}
    />
  );
}
