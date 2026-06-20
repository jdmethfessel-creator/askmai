import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="font-serif text-3xl">No creator here.</h1>
      <p className="mt-3 text-muted text-sm">
        We couldn&apos;t find that slug.
      </p>
      <Link
        href="/"
        className="inline-block mt-6 text-sm underline opacity-70"
      >
        back
      </Link>
    </main>
  );
}
