import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentCliEnvForAgent,
  readAppConfig,
  writeAppConfig,
} from '../../src/app-config.js';
import {
  createRunPerRequestUsageLedger,
  foldEventIntoPerRequestUsageLedger,
  perRequestUsageFromLedger,
} from '../../src/run-analytics-observability.js';
import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import {
  antigravityAgentDef,
  resolveAntigravityAgent,
} from '../../src/runtimes/defs/antigravity.js';
import { spawnEnvForAgent } from '../../src/runtimes/env.js';
import { createJsonEventStreamHandler } from '../../src/runtimes/json-event-stream.js';
import { resolveAntigravityRunContext } from '../../src/server.js';
import { withPlatform } from './helpers/test-helpers.js';

const MULTI_STEP_FIXTURE = new URL(
  '../fixtures/antigravity-stream-json/multi-step-usage.stdout.ndjson',
  import.meta.url,
);

describe('antigravity AGY_AGENT allowlist and --agent flag', () => {
  let dataDir: string;
  let savedCapabilities: Record<string, boolean> | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'od-agy-agent-'));
    savedCapabilities = agentCapabilities.get('antigravity');
  });

  afterEach(() => {
    if (savedCapabilities === undefined) {
      agentCapabilities.delete('antigravity');
    } else {
      agentCapabilities.set('antigravity', savedCapabilities);
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists AGY_AGENT only for antigravity in app-config and overrides case-insensitively on Windows', async () => {
    await writeAppConfig(dataDir, {
      agentCliEnv: {
        antigravity: {
          USERPROFILE: path.join(dataDir, 'lean-home'),
          AGY_AGENT: '  od-lean  ',
        },
        claude: {
          AGY_AGENT: 'should-drop',
        },
      },
    });

    const cfg = await readAppConfig(dataDir);
    expect(cfg.agentCliEnv).toEqual({
      antigravity: {
        USERPROFILE: path.join(dataDir, 'lean-home'),
        AGY_AGENT: 'od-lean',
      },
    });

    const env = withPlatform('win32', () =>
      spawnEnvForAgent(
        'antigravity',
        {
          Path: 'C:\\Windows\\System32',
          Agy_Agent: 'stale-agent',
        },
        agentCliEnvForAgent(cfg.agentCliEnv, 'antigravity'),
        {},
      ),
    );
    expect(env.AGY_AGENT).toBe('od-lean');
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'AGY_AGENT')).toEqual(['AGY_AGENT']);
  });

  it('resolves AGY_AGENT only when name matches regex and <USERPROFILE>/.gemini/config/agents/<name>.md exists', () => {
    const leanHome = path.join(dataDir, 'lean-home');
    const agentsDir = path.join(leanHome, '.gemini', 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, 'od-lean.md'), '# od-lean\n');

    // Valid name + existing file -> resolves through server run context.
    const resolved = withPlatform('win32', () =>
      resolveAntigravityRunContext(
        { Path: 'C:\\Windows\\System32', UserProfile: 'C:\\Users\\daemon' },
        { USERPROFILE: leanHome, AGY_AGENT: 'od-lean' },
      ),
    );
    expect(resolved.antigravityAgent).toBe('od-lean');
    expect(resolved.antigravitySettingsPath).toBe(
      path.join(leanHome, '.gemini', 'antigravity-cli', 'settings.json'),
    );

    // Missing .md file -> undefined.
    const missing = withPlatform('win32', () =>
      resolveAntigravityAgent({ USERPROFILE: leanHome, AGY_AGENT: 'does-not-exist' }),
    );
    expect(missing).toBeUndefined();

    // Invalid names -> undefined even if someone tries path traversal or overlong name.
    for (const badName of ['../od-lean', 'bad name', '-leading', 'a'.repeat(65), '']) {
      const result = withPlatform('win32', () =>
        resolveAntigravityAgent({ USERPROFILE: leanHome, AGY_AGENT: badName }),
      );
      expect(result).toBeUndefined();
    }
  });

  it('passes --agent <name> only when capabilityFlags.agentFlag is detected', () => {
    expect(antigravityAgentDef.capabilityFlags).toMatchObject({
      '--agent': 'agentFlag',
    });

    agentCapabilities.set('antigravity', {
      skipPermissions: true,
      agentFlag: true,
    });
    const withAgent = antigravityAgentDef.buildArgs(
      'hello',
      [],
      [],
      {},
      {
        agentLogFilePath: '/tmp/agy.log',
        antigravityAgent: 'od-lean',
      },
    );
    expect(withAgent).toEqual([
      '--log-file',
      '/tmp/agy.log',
      '--dangerously-skip-permissions',
      '--agent',
      'od-lean',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ]);

    // Older agy without --agent capability falls back safely without passing --agent.
    agentCapabilities.set('antigravity', {
      skipPermissions: true,
      agentFlag: false,
    });
    const withoutCapability = antigravityAgentDef.buildArgs(
      'hello',
      [],
      [],
      {},
      {
        agentLogFilePath: '/tmp/agy.log',
        antigravityAgent: 'od-lean',
      },
    );
    expect(withoutCapability.includes('--agent')).toBe(false);
    expect(withoutCapability.includes('od-lean')).toBe(false);
  });
});

describe('antigravity stream-json per-step request_usage', () => {
  it('emits request_usage for each DONE agent_response step with usage so first call context is separate from aggregate', () => {
    const events: Array<Record<string, unknown>> = [];
    const handler = createJsonEventStreamHandler('antigravity', (ev) => {
      events.push(ev);
    });

    handler.feed(readFileSync(MULTI_STEP_FIXTURE, 'utf8'));
    handler.flush();

    const requestUsages = events.filter((e) => e.type === 'request_usage');
    expect(requestUsages).toEqual([
      {
        type: 'request_usage',
        requestId: 'conv-multi-1:1',
        usage: {
          input_tokens: 27525,
          output_tokens: 410,
          cache_read_input_tokens: 7898,
        },
      },
      {
        type: 'request_usage',
        requestId: 'conv-multi-1:3',
        usage: {
          input_tokens: 12283,
          output_tokens: 320,
          cache_read_input_tokens: 28000,
        },
      },
      {
        type: 'request_usage',
        requestId: 'conv-multi-1:5',
        usage: {
          input_tokens: 40397,
          output_tokens: 900,
          cache_read_input_tokens: 40000,
        },
      },
    ]);

    // Fold into the per-request ledger to confirm first call context vs aggregate sum.
    const ledger = createRunPerRequestUsageLedger();
    for (const ev of events) {
      foldEventIntoPerRequestUsageLedger(ledger, { event: 'agent', data: ev });
    }
    const analytics = perRequestUsageFromLedger(ledger);
    expect(analytics.request_count).toBe(3);
    expect(analytics.records[0]?.input_tokens).toBe(27525);
    expect(analytics.records[0]?.cache_read_input_tokens).toBe(7898);
    expect(analytics.input_tokens_sum).toBe(80205);
    expect(analytics.output_tokens_sum).toBe(1630);
    expect(analytics.cache_read_input_tokens_sum).toBe(75898);
  });
});
