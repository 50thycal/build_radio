import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEpisode, AUTHORED_STATUSES } from '../lib/episode/schema';

/**
 * The authoring guide is what an assistant is pointed at to produce a spec, so
 * a stale example there costs a real round trip and possibly a wasted render.
 * This keeps the document honest against the schema it documents.
 */
describe('episodes/AUTHORING.md', () => {
  const doc = readFileSync(path.join(process.cwd(), 'episodes', 'AUTHORING.md'), 'utf8');

  const example = (): unknown => {
    const match = /```json\n([\s\S]*?)\n```/.exec(doc);
    if (!match) throw new Error('no JSON example found in the authoring guide');
    return JSON.parse(match[1]);
  };

  it('documents an example that actually validates', () => {
    const result = validateEpisode(example());
    if (!result.ok) {
      throw new Error(`example is invalid: ${JSON.stringify(result.issues)}`);
    }
    expect(result.warnings).toEqual([]);
  });

  it('shows a status an author is allowed to write', () => {
    const status = (example() as { status: string }).status;
    expect(AUTHORED_STATUSES).toContain(status as (typeof AUTHORED_STATUSES)[number]);
  });

  it('leaves voices to configuration rather than pinning them', () => {
    const speakers = (example() as { speakers: Record<string, { voice_id: string }> }).speakers;
    expect(Object.keys(speakers)).toContain('host');
    expect(Object.keys(speakers)).toContain('guest');
    for (const speaker of Object.values(speakers)) expect(speaker.voice_id).toBe('');
  });
})
