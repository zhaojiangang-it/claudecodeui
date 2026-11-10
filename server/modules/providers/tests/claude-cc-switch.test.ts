import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  CC_SWITCH_MODEL_PREFIX,
  listCcSwitchClaudeProviders,
  readCcSwitchClaudeProviderEnv,
} from '@/modules/providers/list/claude/claude-cc-switch.provider.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  ClaudeProviderModels,
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { mapCliOptionsToSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// 与 claude-default-model.test.ts 保持一致的隔离方式：把 HOME 钉死在临时目录，
// 并清空别名环境变量，防止开发机 shell（或 CC Switch 写入的配置）泄漏进断言。
const ALIAS_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
] as const;

const withTempHome = async (fn: (homeDir: string) => Promise<void>) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-cc-switch-test-'));
  const originalHome = process.env.HOME;
  const originalEnv: Record<string, string | undefined> = {};
  for (const key of ALIAS_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = homeDir;
  try {
    await fn(homeDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    for (const key of ALIAS_ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await rm(homeDir, { recursive: true, force: true });
  }
};

type FixtureProvider = {
  id: string;
  name: string;
  appType?: string;
  isCurrent?: boolean;
  settingsConfig?: unknown;
  /** 直接传该字段模拟损坏的 settings_config JSON。 */
  rawSettingsConfig?: string;
  sortIndex?: number;
};

/** 在临时 HOME 里造一个最小 schema 的 ~/.cc-switch/cc-switch.db fixture。 */
const writeCcSwitchDb = (homeDir: string, providers: FixtureProvider[]) => {
  const dir = path.join(homeDir, '.cc-switch');
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'cc-switch.db'));
  db.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      sort_index INTEGER,
      is_current INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, app_type)
    )
  `);
  const insert = db.prepare(
    'INSERT INTO providers (id, app_type, name, settings_config, sort_index, is_current) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const provider of providers) {
    insert.run(
      provider.id,
      provider.appType ?? 'claude',
      provider.name,
      provider.rawSettingsConfig ?? JSON.stringify(provider.settingsConfig ?? {}),
      provider.sortIndex ?? 0,
      provider.isCurrent ? 1 : 0,
    );
  }
  db.close();
};

const writeSettings = async (homeDir: string, body: unknown) => {
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(body));
};

const models = new ClaudeProviderModels();

/** 模拟 CC Switch 供应商 settings_config 的 env 块（含密钥,仅测试 fixture）。 */
const QWEN_ENV = {
  ANTHROPIC_BASE_URL: 'https://dashscope.example.com/apps/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'sk-fixture-token',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen-fixture[1M]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen-fixture[1M]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen-fixture',
};

test('listCcSwitchClaudeProviders: 未安装 CC Switch 时返回空列表', async () => {
  await withTempHome(async () => {
    assert.deepEqual(listCcSwitchClaudeProviders(), []);
  });
});

test('listCcSwitchClaudeProviders: 只返回 claude 供应商,按 sort_index 排序,含 isCurrent 与展示模型名', async () => {
  await withTempHome(async (homeDir) => {
    writeCcSwitchDb(homeDir, [
      { id: 'codex-1', name: 'codex 供应商', appType: 'codex', settingsConfig: { env: QWEN_ENV }, sortIndex: 0 },
      {
        id: 'glm-1',
        name: 'glm-5.3',
        settingsConfig: { env: { ...QWEN_ENV, ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3' } },
        sortIndex: 2,
      },
      { id: 'qwen-1', name: 'qwen3.8-max', settingsConfig: { env: QWEN_ENV }, sortIndex: 1, isCurrent: true },
    ]);

    const entries = listCcSwitchClaudeProviders();
    assert.deepEqual(entries.map((entry) => entry.id), ['qwen-1', 'glm-1']);
    assert.equal(entries[0].name, 'qwen3.8-max');
    assert.equal(entries[0].isCurrent, true);
    // env 无 ANTHROPIC_MODEL 时按别名链解析展示名(OPUS 先于 SONNET)
    assert.equal(entries[0].displayName, 'qwen-fixture[1M]');
    assert.equal(entries[1].isCurrent, false);
    assert.equal(entries[1].displayName, 'glm-5.3');
  });
});

test('listCcSwitchClaudeProviders: 顶层 model 键优先于 env 别名映射', async () => {
  await withTempHome(async (homeDir) => {
    writeCcSwitchDb(homeDir, [
      { id: 'p1', name: 'p1', settingsConfig: { model: 'top-model', env: { ANTHROPIC_MODEL: 'env-model' } } },
    ]);
    assert.equal(listCcSwitchClaudeProviders()[0]?.displayName, 'top-model');
  });
});

test('listCcSwitchClaudeProviders: settings_config 损坏或为空的供应商被跳过', async () => {
  await withTempHome(async (homeDir) => {
    writeCcSwitchDb(homeDir, [
      { id: 'broken', name: '损坏行', rawSettingsConfig: 'not-json{' },
      { id: 'empty', name: '空配置行', settingsConfig: {} },
      { id: 'ok', name: '正常行', settingsConfig: { env: QWEN_ENV } },
    ]);
    assert.deepEqual(listCcSwitchClaudeProviders().map((entry) => entry.id), ['ok']);
  });
});

test('readCcSwitchClaudeProviderEnv: 完整复刻供应商 env 并补齐 ANTHROPIC_MODEL', async () => {
  await withTempHome(async (homeDir) => {
    writeCcSwitchDb(homeDir, [{ id: 'qwen-1', name: 'qwen', settingsConfig: { env: QWEN_ENV } }]);
    const env = readCcSwitchClaudeProviderEnv('qwen-1');
    assert.ok(env);
    // 原有键原样保留(密钥只在服务端内部流转,不进 API 响应)
    for (const [key, value] of Object.entries(QWEN_ENV)) {
      assert.equal(env[key], value);
    }
    // 无 ANTHROPIC_MODEL 时按展示链补齐,保证 CLI `default` 别名解析确定
    assert.equal(env.ANTHROPIC_MODEL, 'qwen-fixture[1M]');
  });
});

test('readCcSwitchClaudeProviderEnv: 未知 id 或损坏配置返回 null', async () => {
  await withTempHome(async (homeDir) => {
    writeCcSwitchDb(homeDir, [{ id: 'broken', name: '损坏行', rawSettingsConfig: 'oops' }]);
    assert.equal(readCcSwitchClaudeProviderEnv('missing-id'), null);
    assert.equal(readCcSwitchClaudeProviderEnv('broken'), null);
  });
});

test('getSupportedModels: 有 CC Switch 时目录为 Default+供应商,官方预设隐藏', async () => {
  await withTempHome(async (homeDir) => {
    writeCcSwitchDb(homeDir, [
      { id: 'qwen-1', name: 'qwen3.8-max', settingsConfig: { env: QWEN_ENV }, isCurrent: true, sortIndex: 1 },
      {
        id: 'glm-1',
        name: 'glm-5.3',
        settingsConfig: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3' } },
        sortIndex: 2,
      },
    ]);
    await writeSettings(homeDir, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen-fixture[1M]' } });

    const catalog = await models.getSupportedModels();
    assert.equal(catalog.DEFAULT, CLAUDE_PREDEFINED_MODELS.DEFAULT);
    assert.deepEqual(
      catalog.OPTIONS.map((option) => option.value),
      ['default', `${CC_SWITCH_MODEL_PREFIX}qwen-1`, `${CC_SWITCH_MODEL_PREFIX}glm-1`],
    );

    const defaultOption = catalog.OPTIONS[0];
    // Default 选项继续透出本机配置解析出的真实模型名(0ca28472 行为不回归)
    assert.ok(defaultOption?.description?.includes('Currently resolves to "qwen-fixture[1M]"'));

    const qwenOption = catalog.OPTIONS[1];
    assert.equal(qwenOption?.label, 'qwen3.8-max');
    assert.ok(qwenOption?.description?.includes('Model: qwen-fixture[1M]'));
    assert.ok(qwenOption?.description?.includes('Currently active in CC Switch'));
    // 供应商选项复用 Default 的 effort 定义,推理力度 UI 体验一致
    assert.deepEqual(qwenOption?.effort, defaultOption?.effort);

    const glmOption = catalog.OPTIONS[2];
    assert.ok(glmOption?.description?.includes('Model: glm-5.3'));
    assert.ok(!glmOption?.description?.includes('Currently active'));
  });
});

test('getSupportedModels: db 中没有 claude 行时保留官方静态目录', async () => {
  await withTempHome(async (homeDir) => {
    writeCcSwitchDb(homeDir, [
      { id: 'codex-1', name: 'codex', appType: 'codex', settingsConfig: { env: QWEN_ENV } },
    ]);
    const catalog = await models.getSupportedModels();
    assert.equal(catalog, CLAUDE_PREDEFINED_MODELS);
  });
});

test('mapCliOptionsToSDK: cc-switch 前缀注入 settings.env,model 回落 default 别名', async () => {
  await withTempHome(async (homeDir) => {
    writeCcSwitchDb(homeDir, [{ id: 'qwen-1', name: 'qwen', settingsConfig: { env: QWEN_ENV } }]);
    const sdkOptions = mapCliOptionsToSDK({ model: `${CC_SWITCH_MODEL_PREFIX}qwen-1` });
    assert.equal(sdkOptions.model, CLAUDE_PREDEFINED_MODELS.DEFAULT);
    // env 经 flag settings 层注入(优先级高于 ~/.claude/settings.json 的 env 块)
    assert.equal(sdkOptions.settings?.env?.ANTHROPIC_AUTH_TOKEN, 'sk-fixture-token');
    assert.equal(sdkOptions.settings?.env?.ANTHROPIC_BASE_URL, QWEN_ENV.ANTHROPIC_BASE_URL);
    assert.equal(sdkOptions.settings?.env?.ANTHROPIC_MODEL, 'qwen-fixture[1M]');
  });
});

test('mapCliOptionsToSDK: 未知 cc-switch id 不注入 settings,model 回落 default', async () => {
  await withTempHome(async () => {
    const sdkOptions = mapCliOptionsToSDK({ model: `${CC_SWITCH_MODEL_PREFIX}missing` });
    assert.equal(sdkOptions.model, CLAUDE_PREDEFINED_MODELS.DEFAULT);
    assert.equal(sdkOptions.settings, undefined);
  });
});

test('mapCliOptionsToSDK: 普通模型值不受 CC Switch 解析影响', async () => {
  await withTempHome(async () => {
    const sdkOptions = mapCliOptionsToSDK({ model: 'sonnet' });
    assert.equal(sdkOptions.model, 'sonnet');
    assert.equal(sdkOptions.settings, undefined);
  });
});
