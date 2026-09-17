'use client';

/**
 * Generation controls.
 *
 * Every button that can spend money says what it will cost before it is
 * pressed, and regeneration asks for confirmation — the UI is the last guard
 * in front of the provider bill.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Props = {
  slug: string;
  estimatedCostUsd: number;
  canGenerate: boolean;
  hasAudio: boolean;
  hasFailedChunks: boolean;
  blockedReason?: string | null;
};

type Outcome = { message: string; isError: boolean } | null;

export function GenerationControls({
  slug,
  estimatedCostUsd,
  canGenerate,
  hasAudio,
  hasFailedChunks,
  blockedReason,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function post(url: string, body: unknown, label: string) {
    setBusy(label);
    setOutcome(null);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const message =
        typeof payload.reason === 'string'
          ? payload.reason
          : typeof payload.error === 'string'
            ? payload.error
            : `${payload.status ?? response.status}`;
      setOutcome({ message, isError: !response.ok });
      router.refresh();
    } catch (error) {
      setOutcome({ message: (error as Error).message, isError: true });
    } finally {
      setBusy(null);
    }
  }

  const cost = `$${estimatedCostUsd.toFixed(2)}`;

  return (
    <div className="actions">
      <button
        type="button"
        className="primary"
        disabled={!canGenerate || busy !== null}
        onClick={() => post('/api/generate', { slug, kind: 'generate' }, 'generate')}
      >
        {busy === 'generate' ? 'Starting…' : `Generate episode · ${cost}`}
      </button>

      {hasFailedChunks ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            if (!confirm('Retry the failed chunks? This will use ElevenLabs credits for those chunks.')) return;
            void post('/api/generate', { slug, kind: 'regenerate_failed' }, 'retry');
          }}
        >
          {busy === 'retry' ? 'Starting…' : 'Regenerate failed chunks'}
        </button>
      ) : null}

      <button
        type="button"
        disabled={busy !== null}
        onClick={() => {
          if (!confirm(`Regenerate the whole episode? This will spend roughly ${cost} of ElevenLabs credits again.`)) {
            return;
          }
          void post('/api/generate', { slug, kind: 'regenerate_all' }, 'regenerate');
        }}
      >
        {busy === 'regenerate' ? 'Starting…' : `Regenerate entire episode · ${cost}`}
      </button>

      {hasAudio ? (
        <button
          type="button"
          className="danger"
          disabled={busy !== null}
          onClick={() => {
            if (!confirm('Delete the generated audio file? Chunk audio is kept, so re-publishing is free.')) return;
            void post('/api/admin/audio', { slug }, 'delete');
          }}
        >
          {busy === 'delete' ? 'Deleting…' : 'Delete generated audio'}
        </button>
      ) : null}

      {blockedReason ? <p className="action-note">{blockedReason}</p> : null}
      <p className="action-note">
        Regeneration always consumes new ElevenLabs credits. Chunks already rendered at this content version are
        reused unless you choose a full regenerate.
      </p>

      {outcome ? <p className={`action-result${outcome.isError ? ' error' : ''}`}>{outcome.message}</p> : null}
    </div>
  );
}
