import Link from 'next/link';

/** Wordmark plus the two places worth navigating to on a phone. */
export function Masthead({ current }: { current: 'library' | 'admin' }) {
  return (
    <header className="masthead">
      <Link href="/" className="wordmark">
        Build OS Radio
      </Link>
      <nav>{current === 'admin' ? <Link href="/">Library</Link> : <Link href="/admin">Studio</Link>}</nav>
    </header>
  );
}
