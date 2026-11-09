import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_PREDEFINED_MODELS,
  ClaudeProviderModels,
} from '@/modules/providers/list/claude/claude-models.provider.js';

// 把「默认模型解析」钉死在临时 HOME 里，并清空别名环境变量，
// 防止开发机 shell（或 CC Switch 写入的配置）泄漏进断言。
// withTempHome/withEnv 模式与 claude-auth.test.ts 保持一致。
const ALIAS_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
] as const;

const withTempHome = async (fn: (homeDir: string) => Promise<void>) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-default-model-test-'));
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

const writeSettings = async (homeDir: string, body: unknown) => {
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(body));
};

const models = new ClaudeProviderModels();

test('getCurrentActiveModel: 无 settings.json 时退回 catalog 默认值', async () => {
  await withTempHome(async () => {
    const active = await models.getCurrentActiveModel();
    assert.equal(active.model, CLAUDE_PREDEFINED_MODELS.DEFAULT);
  });
});

test('getCurrentActiveModel: 读取 settings.json 顶层 model 键', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettings(homeDir, { model: 'claude-fable-5' });
    const active = await models.getCurrentActiveModel();
    assert.equal(active.model, 'claude-fable-5');
  });
});

test('getCurrentActiveModel: 顶层 model 键优先于 env 别名映射', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettings(homeDir, {
      model: 'claude-from-model-key',
      env: { ANTHROPIC_MODEL: 'claude-from-env' },
    });
    const active = await models.getCurrentActiveModel();
    assert.equal(active.model, 'claude-from-model-key');
  });
});

test('getCurrentActiveModel: 解析 CC Switch 风格的 env 别名映射', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettings(homeDir, {
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-max-0902[1M]' },
    });
    const active = await models.getCurrentActiveModel();
    assert.equal(active.model, 'qwen3.8-max-0902[1M]');
  });
});

test('getCurrentActiveModel: ANTHROPIC_MODEL 优先于分层别名', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettings(homeDir, {
      env: {
        ANTHROPIC_MODEL: 'from-anthropic-model',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'from-fable-alias',
      },
    });
    const active = await models.getCurrentActiveModel();
    assert.equal(active.model, 'from-anthropic-model');
  });
});

test('getCurrentActiveModel: 进程环境变量作为最后兜底', async () => {
  await withTempHome(async () => {
    process.env.ANTHROPIC_MODEL = 'from-process-env';
    try {
      const active = await models.getCurrentActiveModel();
      assert.equal(active.model, 'from-process-env');
    } finally {
      delete process.env.ANTHROPIC_MODEL;
    }
  });
});

test('getSupportedModels: Default 选项描述透出配置解析出的真实模型名', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettings(homeDir, { model: 'claude-fable-5' });
    const catalog = await models.getSupportedModels();
    const defaultOption = catalog.OPTIONS.find(
      (option) => option.value === CLAUDE_PREDEFINED_MODELS.DEFAULT,
    );
    assert.ok(defaultOption?.description?.includes('claude-fable-5'));
    // value 与 DEFAULT 必须保持原样，选择/提交逻辑不受影响
    assert.equal(catalog.DEFAULT, CLAUDE_PREDEFINED_MODELS.DEFAULT);
    assert.equal(defaultOption?.value, CLAUDE_PREDEFINED_MODELS.DEFAULT);
    // 其他选项不受污染
    const bestOption = catalog.OPTIONS.find((option) => option.value === 'best');
    assert.ok(!bestOption?.description?.includes('claude-fable-5'));
  });
});

test('getSupportedModels: 未配置时原样返回静态 catalog', async () => {
  await withTempHome(async () => {
    const catalog = await models.getSupportedModels();
    assert.equal(catalog, CLAUDE_PREDEFINED_MODELS);
    const defaultOption = catalog.OPTIONS.find(
      (option) => option.value === CLAUDE_PREDEFINED_MODELS.DEFAULT,
    );
    assert.ok(!defaultOption?.description?.includes('Currently resolves to'));
  });
});
