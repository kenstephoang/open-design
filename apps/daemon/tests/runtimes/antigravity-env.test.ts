import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentCliEnvForAgent,
  readAppConfig,
  writeAppConfig,
} from '../../src/app-config.js';
import { isLocalSameOrigin } from '../../src/origin-validation.js';
import { spawnEnvForAgent } from '../../src/runtimes/env.js';
import {
  antigravityAgentDef,
  resolveAntigravitySettingsPath,
} from '../../src/runtimes/defs/antigravity.js';
import { resolveAntigravityRunSettingsPath } from '../../src/server.js';
import { withPlatform } from './helpers/test-helpers.js';

describe('antigravity agentCliEnv and spawn env', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'od-agy-env-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists allowed antigravity agentCliEnv keys via PUT /api/app-config and drops unknown keys', async () => {
    const app = express();
    app.use(express.json());
    let boundPort = 0;

    app.get('/api/app-config', async (_req, res) => {
      const config = await readAppConfig(dataDir);
      res.json({ config });
    });

    app.put('/api/app-config', async (req, res) => {
      if (!isLocalSameOrigin(req, boundPort)) {
        return res.status(403).json({ error: 'cross-origin request rejected' });
      }
      const config = await writeAppConfig(dataDir, req.body);
      res.json({ config });
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    boundPort = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const customHome = path.join(dataDir, 'agy-account-1');
      const putRes = await fetch(`http://127.0.0.1:${boundPort}/api/app-config`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${boundPort}`,
        },
        body: JSON.stringify({
          agentCliEnv: {
            antigravity: {
              USERPROFILE: `  ${customHome}  `,
              HOME: `  ${customHome}  `,
              AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1',
              AGY_CLI_DISABLE_AUTO_UPDATE: '1',
              PATH: 'C:\\evil\\path',
              UNRELATED_KEY: 'drop-me',
            },
            claude: {
              USERPROFILE: customHome,
              HOME: customHome,
            },
          },
        }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await fetch(`http://127.0.0.1:${boundPort}/api/app-config`);
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as {
        config: { agentCliEnv?: Record<string, Record<string, string>> };
      };

      expect(body.config.agentCliEnv).toEqual({
        antigravity: {
          USERPROFILE: customHome,
          HOME: customHome,
          AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1',
          AGY_CLI_DISABLE_AUTO_UPDATE: '1',
        },
      });
      expect(agentCliEnvForAgent(body.config.agentCliEnv, 'antigravity')).toEqual({
        USERPROFILE: customHome,
        HOME: customHome,
        AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1',
        AGY_CLI_DISABLE_AUTO_UPDATE: '1',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('lets configured antigravity env override differently-cased daemon keys on Windows', () => {
    const customHome = 'D:\\work\\.agent-runtime\\agy-accounts\\acct1';
    const env = withPlatform('win32', () =>
      spawnEnvForAgent(
        'antigravity',
        {
          Path: 'C:\\Windows\\System32',
          UserProfile: 'C:\\Users\\daemon',
          Home: 'C:\\Users\\daemon',
          Agy_Cli_Force_File_Token_Storage: '0',
          Agy_Cli_Disable_Auto_Update: '0',
        },
        {
          USERPROFILE: customHome,
          HOME: customHome,
          AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1',
          AGY_CLI_DISABLE_AUTO_UPDATE: '1',
        },
        {},
      ),
    );

    expect(env.USERPROFILE).toBe(customHome);
    expect(env.HOME).toBe(customHome);
    expect(env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1');
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('1');
    expect(env.Path).toBe('C:\\Windows\\System32');

    // No duplicate case-variant keys remain alongside the canonical keys.
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'USERPROFILE')).toEqual(['USERPROFILE']);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'HOME')).toEqual(['HOME']);
    expect(
      Object.keys(env).filter((k) => k.toUpperCase() === 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE'),
    ).toEqual(['AGY_CLI_FORCE_FILE_TOKEN_STORAGE']);
    expect(
      Object.keys(env).filter((k) => k.toUpperCase() === 'AGY_CLI_DISABLE_AUTO_UPDATE'),
    ).toEqual(['AGY_CLI_DISABLE_AUTO_UPDATE']);
  });

  it('preserves daemon UserProfile when antigravity configuredEnv does not override it', () => {
    const env = withPlatform('win32', () =>
      spawnEnvForAgent(
        'antigravity',
        {
          Path: 'C:\\Windows\\System32',
          UserProfile: 'C:\\Users\\daemon',
        },
        {
          AGY_CLI_DISABLE_AUTO_UPDATE: '1',
        },
        {},
      ),
    );

    expect(env.UserProfile).toBe('C:\\Users\\daemon');
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('1');
  });

  it('falls back to homedir when USERPROFILE or HOME is relative, and handles case-insensitive UserProfile', () => {
    const expectedFallback = path.join(
      homedir(),
      '.gemini',
      'antigravity-cli',
      'settings.json',
    );

    const relativeWin = withPlatform('win32', () =>
      resolveAntigravitySettingsPath({ USERPROFILE: 'relative\\agy-home' }),
    );
    expect(relativeWin).toBe(expectedFallback);

    const mixedCaseWin = withPlatform('win32', () =>
      resolveAntigravitySettingsPath({
        UserProfile: 'D:\\work\\.agent-runtime\\agy-accounts\\acct2',
      }),
    );
    expect(mixedCaseWin).toBe(
      path.join(
        'D:\\work\\.agent-runtime\\agy-accounts\\acct2',
        '.gemini',
        'antigravity-cli',
        'settings.json',
      ),
    );

    const linuxHome = withPlatform('linux', () =>
      resolveAntigravitySettingsPath({
        USERPROFILE: 'C:\\Users\\ignored-on-linux',
        HOME: '/home/agy-acct',
      }),
    );
    expect(linuxHome).toBe(
      path.join('/home/agy-acct', '.gemini', 'antigravity-cli', 'settings.json'),
    );

    const relativeLinux = withPlatform('linux', () =>
      resolveAntigravitySettingsPath({ HOME: 'relative/agy-home' }),
    );
    expect(relativeLinux).toBe(expectedFallback);
  });

  it('resolves antigravity settings.json through server.ts run helper from configured run env and writes model selection there', () => {
    const customHome = path.join(dataDir, 'agy-home');
    const settingsPath = withPlatform('win32', () =>
      resolveAntigravityRunSettingsPath(
        {
          Path: 'C:\\Windows\\System32',
          UserProfile: 'C:\\Users\\daemon',
        },
        {
          USERPROFILE: customHome,
        },
      ),
    );

    expect(settingsPath).toBe(
      path.join(customHome, '.gemini', 'antigravity-cli', 'settings.json'),
    );

    antigravityAgentDef.buildArgs(
      'hello',
      [],
      [],
      { model: 'Gemini 3.1 Pro (High)' },
      { antigravitySettingsPath: settingsPath },
    );

    expect(existsSync(settingsPath)).toBe(true);
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      model?: string;
    };
    expect(saved.model).toBe('Gemini 3.1 Pro (High)');
  });
});
