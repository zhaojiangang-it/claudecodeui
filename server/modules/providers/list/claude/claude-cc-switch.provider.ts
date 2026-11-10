import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  isPlaceholderProviderModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * CC Switch v3 联动数据源：只读解析 ~/.cc-switch/cc-switch.db（SQLite）中
 * app_type='claude' 的供应商，供 claude-models.provider.ts 生成模型目录、
 * claude-runtime.provider.ts 做会话级 env 注入。
 *
 * 实时性约定：每次调用都直接读库，不做任何缓存——用户在 CC Switch 里
 * 新增/删除供应商后，模型菜单下一次拉取目录立即可见。
 *
 * 容错约定：目录缺失、db 损坏、表缺失、锁冲突一律静默降级（空列表 / null），
 * 未安装 CC Switch 的机器上 claudecodeui 必须照常工作。
 */

/**
 * 模型目录中 CC Switch 供应商选项的 value 前缀。
 * claude-models.provider.ts 用它拼选项 value，claude-runtime.provider.ts
 * 用它识别"这是一次会话级供应商切换"并解析出供应商 id。
 */
export const CC_SWITCH_MODEL_PREFIX = 'cc-switch:';

/**
 * claude-models.provider.ts 生成目录选项用的列表项。
 * 刻意不含 env（里面有密钥）——密钥只允许经 readCcSwitchClaudeProviderEnv
 * 在服务端运行时内部流转，绝不进入 API 响应。
 */
export type CcSwitchClaudeProviderEntry = {
  id: string;
  name: string;
  /** CC Switch 当前全局激活的供应商（providers.is_current）。 */
  isCurrent: boolean;
  /** 从 settings_config 解析出的实际模型名，仅用于展示；解析不出为 null。 */
  displayName: string | null;
};

/** providers 表里本模块关心的列；is_current 在 SQLite 中是 0/1。 */
type CcSwitchProviderRow = {
  id: string;
  name: string;
  is_current: number | boolean;
  settings_config: string;
  sort_index?: number | null;
};

type CcSwitchSettingsConfig = {
  env: Record<string, string>;
  topModel: string | null;
};

/**
 * 展示模型名的解析链，与 claude-models.provider.ts 的
 * CLAUDE_DEFAULT_ALIAS_ENV_KEYS 同思路：顶层 model 键优先，
 * 其后按别名映射逐级兜底（CC Switch 供应商通常只写 env 块）。
 */
const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

const ccSwitchDbPath = (): string => path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

const readProviderRows = (): CcSwitchProviderRow[] => {
  try {
    // 只读打开 + fileMustExist：CC Switch 可能正在运行，绝不触碰它的写锁；
    // 文件不存在时直接走 catch 降级，不产生建库副作用。
    const db = new Database(ccSwitchDbPath(), { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare(
          `SELECT id, name, is_current, settings_config
             FROM providers
            WHERE app_type = 'claude'
            ORDER BY sort_index`,
        )
        .all() as CcSwitchProviderRow[];
    } finally {
      db.close();
    }
  } catch {
    // 未安装 CC Switch / db 损坏 / 表缺失 / 锁冲突：一律视为没有供应商。
    return [];
  }
};

const parseSettingsConfig = (raw: unknown): CcSwitchSettingsConfig | null => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }

  let config: ReturnType<typeof readObjectRecord>;
  try {
    config = readObjectRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!config) {
    return null;
  }

  const env: Record<string, string> = {};
  const envRecord = readObjectRecord(config.env);
  if (envRecord) {
    for (const [key, value] of Object.entries(envRecord)) {
      // 只保留非空字符串值；密钥等敏感值原样保留（仅服务端内部使用）。
      if (typeof value === 'string' && value.length > 0) {
        env[key] = value;
      }
    }
  }

  const rawTopModel = readOptionalString(config.model)?.trim() ?? null;
  const topModel = rawTopModel && !isPlaceholderProviderModel(rawTopModel) ? rawTopModel : null;
  // env 与 model 都为空的供应商没有可注入内容，视为配置损坏。
  if (Object.keys(env).length === 0 && !topModel) {
    return null;
  }

  return { env, topModel };
};

const resolveDisplayName = (parsed: CcSwitchSettingsConfig): string | null => {
  if (parsed.topModel) {
    return parsed.topModel;
  }
  for (const key of MODEL_ENV_KEYS) {
    const value = parsed.env[key]?.trim();
    if (value && !isPlaceholderProviderModel(value)) {
      return value;
    }
  }
  return null;
};

/**
 * claude-models.provider.ts 用它把 CC Switch 供应商列进模型目录。
 * 按 CC Switch 里的排序返回；settings_config 损坏的行直接跳过
 * （选了也无法注入，列出来只会得到运行时报错）。
 */
export const listCcSwitchClaudeProviders = (): CcSwitchClaudeProviderEntry[] => {
  const entries: CcSwitchClaudeProviderEntry[] = [];
  for (const row of readProviderRows()) {
    const parsed = parseSettingsConfig(row.settings_config);
    if (!parsed) {
      continue;
    }
    const id = readOptionalString(row.id)?.trim();
    if (!id) {
      continue;
    }
    entries.push({
      id,
      name: readOptionalString(row.name)?.trim() || id,
      isCurrent: row.is_current === 1 || row.is_current === true,
      displayName: resolveDisplayName(parsed),
    });
  }
  return entries;
};

/**
 * claude-runtime.provider.ts 用它做会话级注入：返回指定供应商的完整 env 块，
 * 忠实复刻 CC Switch 全局切换写进 ~/.claude/settings.json 的内容
 * （端点、密钥、各档位模型映射），并保证 ANTHROPIC_MODEL 一定存在，
 * 让 CLI 的 `default` 别名解析是确定性的。
 *
 * 供应商不存在（如已被用户从 CC Switch 删除）或配置损坏时返回 null，
 * 由调用方回退到 `default` 别名（即当前全局配置）。
 */
export const readCcSwitchClaudeProviderEnv = (providerId: string): Record<string, string> | null => {
  const wantedId = providerId.trim();
  if (!wantedId) {
    return null;
  }

  const row = readProviderRows().find((candidate) => readOptionalString(candidate.id)?.trim() === wantedId);
  if (!row) {
    return null;
  }

  const parsed = parseSettingsConfig(row.settings_config);
  if (!parsed) {
    return null;
  }

  const env = { ...parsed.env };
  if (!env.ANTHROPIC_MODEL) {
    const displayName = resolveDisplayName(parsed);
    if (displayName) {
      env.ANTHROPIC_MODEL = displayName;
    }
  }
  return env;
};
