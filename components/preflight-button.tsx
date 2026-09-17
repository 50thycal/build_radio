'use client';

/**
 * The tap that replaces `npm run check:provider`.
 *
 * Shows the result in the terms that matter: did it work, what did it cost,
 * and — when it failed — which of the two likely causes it was.
 */
import { useState } from 'react';

type PreflightResult = {
  ok: boolean;
  stage: string;
  message: string;
  hint?: string;
  kind?: string;
  status?: number | null;
  costUsd?: number;
  latencyMs?: number;
  durationSeconds?: number;
  sampleRate?: number;
  charactersPerSecond?: number;
  model?: string;
  outputFormat?: string;
};

export function PreflightButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreflightResult | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch('/api/admin/preflight', { method: 'POST' });
      setResult((await response.json()) as PreflightResult);
    } catch (error) {
      setResult({ ok: false, stage: 'network', message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="actions">
      <button type="button" className="primary" disabled={busy} onClick={run}>
        {busy ? 'Calling ElevenLabs…' : 'Run preflight · under $0.01'}
      </button>
      <p className="action-note">
        Sends one short two-speaker line to ElevenLabs and checks the whole chain: key, both voices, the
        Text-to-Dialogue endpoint, and whether the audio is joinable. Run this before rendering an episode.
      </p>

      {result ? (
        <div className={`action-result${result.ok ? '' : ' error'}`}>
          <strong>{result.ok ? '✓ Ready to render' : '✗ Not ready'}</strong>
          {'\n'}
          {result.message}
          {result.hint ? `\n${result.hint}` : ''}
          {result.ok ? (
            <>
              {'\n\n'}
              {`model            ${result.model}`}
              {'\n'}
              {`format           ${result.outputFormat}`}
              {'\n'}
              {`cost             $${(result.costUsd ?? 0).toFixed(4)}`}
              {'\n'}
              {`latency          ${result.latencyMs} ms`}
              {'\n'}
              {`audio            ${result.durationSeconds}s @ ${result.sampleRate} Hz`}
              {'\n'}
              {`chars per second ${result.charactersPerSecond}`}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
