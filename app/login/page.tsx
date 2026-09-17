/**
 * Sign in. One password, one owner; there are no accounts to manage.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectTo?: string }>;
}) {
  const { error, redirectTo } = await searchParams;
  return (
    <main className="login">
      <h1>Build OS Radio</h1>
      {error ? <p className="error-text">Incorrect password.</p> : null}
      <form action="/api/auth/login" method="post">
        <input type="hidden" name="redirectTo" value={redirectTo ?? '/'} />
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          required
        />
        <button type="submit">Listen</button>
      </form>
    </main>
  );
}
