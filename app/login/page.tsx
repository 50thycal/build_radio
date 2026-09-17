/**
 * Sign in. One password, one owner; there are no accounts to manage.
 *
 * A deployment with no credentials yet shows the setup checklist instead of a
 * form it cannot honour — the first useful thing a fresh deploy can say.
 */
import { SetupChecklist } from '@/components/setup-checklist';
import { evaluateReadiness } from '@/lib/readiness';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectTo?: string }>;
}) {
  const { error, redirectTo } = await searchParams;
  const readiness = evaluateReadiness();

  if (!readiness.canSignIn) {
    return (
      <main className="shell setup-shell">
        <h1 className="wordmark setup-wordmark">Build OS Radio</h1>
        <p className="prose setup-intro">
          The deployment is live. It needs credentials before anyone can sign in or render an episode.
        </p>
        <SetupChecklist readiness={readiness} heading="Finish setup" />
      </main>
    );
  }

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
