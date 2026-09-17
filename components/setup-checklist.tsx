/**
 * Setup checklist.
 *
 * Shown on the login page when a deployment has no credentials yet, and in the
 * studio as a permanent status panel. It names the exact environment variables
 * to set, in the order they matter, and never renders a secret's value.
 */
import type { Readiness } from '@/lib/readiness';

const STATUS_LABEL = { ok: 'Ready', warn: 'Check', missing: 'Needed' } as const;
const STATUS_CLASS = { ok: 'badge-published', warn: 'badge-ready', missing: 'badge-failed' } as const;

export function SetupChecklist({
  readiness,
  heading = 'Setup',
}: {
  readiness: Readiness;
  heading?: string;
}) {
  const outstanding = readiness.checks.filter((check) => check.status !== 'ok');

  return (
    <section className="estimate-card setup-card">
      <h3>{heading}</h3>
      <p className="title">
        {outstanding.length === 0
          ? 'Everything is configured.'
          : `${outstanding.length} item${outstanding.length === 1 ? '' : 's'} to finish`}
      </p>

      <ul className="setup-list">
        {readiness.checks.map((check) => (
          <li key={check.key}>
            <div className="setup-row">
              <span className="setup-label">{check.label}</span>
              <span className={`badge ${STATUS_CLASS[check.status]}`}>{STATUS_LABEL[check.status]}</span>
            </div>
            <p className="setup-detail">{check.detail}</p>
            {check.status !== 'ok' ? (
              <p className="setup-vars">
                {check.variables.map((variable) => (
                  <code key={variable}>{variable}</code>
                ))}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="action-note setup-footer">
        Set these in Vercel under <strong>Settings → Environment Variables</strong>, then redeploy.
        Generate each secret with <code>openssl rand -hex 32</code>. Full instructions are in the
        README.
      </p>
    </section>
  );
}
