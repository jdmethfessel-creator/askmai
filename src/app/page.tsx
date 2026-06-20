import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="font-serif text-4xl tracking-tight">AskMai</h1>
      <p className="mt-3 text-muted text-sm leading-relaxed">
        Chat with your favorite creator&apos;s AI. Get the picks they&apos;d
        actually recommend, in their voice.
      </p>
      <div className="mt-10 space-y-2">
        <p className="text-xs uppercase tracking-widest text-muted">
          Try a creator
        </p>
        <Link
          href="/cass"
          className="inline-block rounded-full bg-ink text-bg px-5 py-2.5 text-sm font-medium"
        >
          /cass — Cass DiMicco
        </Link>
      </div>
    </main>
  );
}
