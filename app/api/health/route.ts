/**
 * Readiness endpoint.
 *
 * Unauthenticated on purpose: it is the first thing you can call against a new
 * deployment, before any secret exists, and it reveals only whether each
 * variable is set — never a value. It is also a useful uptime check.
 */
import { evaluateReadiness, probeDatabase } from '@/lib/readiness';
import { json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const readiness = evaluateReadiness();
  const database = await probeDatabase();

  const body = {
    status: readiness.canSignIn && readiness.canGenerate && database.ok ? 'ready' : 'setup-required',
    canSignIn: readiness.canSignIn,
    canGenerate: readiness.canGenerate,
    storageDurable: readiness.storageDurable,
    database,
    environment: readiness.environment,
    checks: readiness.checks.map((check) => ({
      key: check.key,
      label: check.label,
      status: check.status,
      detail: check.detail,
      variables: check.variables,
    })),
  };

  // 200 either way: "not configured yet" is a valid state, not a server fault.
  return json(body);
}
