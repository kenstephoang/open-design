/**
 * A cold-hydrated terminal run must cost the same memory as a live one.
 *
 * `hydrateDurableRun` used to parse the whole `events.jsonl` into `run.events`
 * and never schedule the terminal TTL, so one `GET /api/runs?projectId` after a
 * restart pinned a project's entire event history in the heap for the life of
 * the process (measured: 460 runs, 8.3M events, +1.2 GB within one minute).
 * A live run only ever holds the last `maxEvents` records and is evicted
 * `ttlMs` after it ends; `stream()` already replays everything older from the
 * journal. These specs pin that a hydrated run obeys the same two bounds and
 * that a subscriber still receives the complete history.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { createChatRunService } from '../src/runtimes/runs.js';

const MAX_EVENTS = 5;
const TTL_MS = 40;
const PROJECT_ID = 'cold-hydration-project';

let directory: string | undefined;
afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

type Sent = { event: string; id: number };

function newService(root: string, sent: Sent[] = []) {
  return createChatRunService({
    createSseResponse: () => ({
      send: (event: string, _data: unknown, id: number) => { sent.push({ event, id }); return true; },
      end() {},
      cleanup() {},
    }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    maxEvents: MAX_EVENTS,
    ttlMs: TTL_MS,
    // The existing JS-inferred service option defaults to null.
    runsLogDir: path.join(root, 'runs') as unknown as null,
  });
}

/** A real terminal run whose journal is several times longer than the ring. */
async function writeLongTerminalRun(root: string): Promise<{ id: string; journalIds: number[] }> {
  const warm = newService(root);
  const run = warm.create({ projectId: PROJECT_ID, agentId: 'codex' });
  for (let i = 0; i < MAX_EVENTS * 6; i++) {
    // Multi-byte text so a tail read that cuts mid-character would corrupt a record.
    warm.emit(run, 'agent', { type: 'text_delta', delta: `đoạn ${i} — ${'ấ'.repeat(40)}` });
  }
  const log = run.eventsLogStream;
  if (!log) throw new Error('The real event journal was not opened');
  const flushed = finished(log);
  warm.finish(run, 'succeeded', 0, null);
  await flushed;
  const journalIds = fs.readFileSync(path.join(root, 'runs', run.id, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line).id as number);
  return { id: run.id, journalIds };
}

describe('cold hydration of a terminal run', () => {
  it('keeps only the ring-sized tail of the journal in memory', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-cold-hydration-'));
    const { id, journalIds } = await writeLongTerminalRun(directory);
    expect(journalIds.length).toBeGreaterThan(MAX_EVENTS * 5);

    const hydrated = newService(directory).get(id);
    if (!hydrated) throw new Error('Cold hydration lost the real run');
    expect(hydrated.events.map((record: { id: number }) => record.id))
      .toEqual(journalIds.slice(-MAX_EVENTS));
    expect(hydrated.events.at(-1).event).toBe('end');
    expect(hydrated.nextEventId).toBe(journalIds.at(-1)! + 1);
  });

  it('still replays the complete history to a subscriber', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-cold-hydration-'));
    const { id, journalIds } = await writeLongTerminalRun(directory);
    const sent: Sent[] = [];
    const cold = newService(directory, sent);
    const hydrated = cold.get(id);
    if (!hydrated) throw new Error('Cold hydration lost the real run');

    await cold.stream(
      hydrated,
      { get: () => undefined, query: {} },
      { on() {} },
    );
    expect(sent.map((record) => record.id)).toEqual(journalIds);
    expect(sent.at(-1)!.event).toBe('end');
  });

  it('evicts the hydrated run after the terminal TTL and rehydrates on demand', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-cold-hydration-'));
    const { id } = await writeLongTerminalRun(directory);
    const cold = newService(directory);

    const [first] = cold.list({ projectId: PROJECT_ID });
    expect(first?.id).toBe(id);
    expect(cold.get(id)).toBe(first);

    await sleep(TTL_MS * 4);
    const second = cold.get(id);
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ id, status: 'succeeded' });
    expect(cold.list({ projectId: PROJECT_ID }).map((run: { id: string }) => run.id)).toEqual([id]);
  });
});
