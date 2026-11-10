# Rose 定制版部署与上游同步手册

> 适用对象:本仓库(CloudCLI,原 claudecodeui,AGPL-3.0,上游 github.com/siteboon/claudecodeui)。
> 维护约定:部署方式、同步流程、踩坑经验有任何变化,直接更新本文件并单独 commit。
> 首版:2026-11-10(随 CC Switch 联动功能落地时编写)。

## 0. 格局速览

- **日常在跑的实例** = 全局 npm 包 `@cloudcli-ai/cloudcli`,由 launchd 用户级服务 `com.rose.cloudcli` 常驻(登录自启 + 崩溃约 10s 自动拉起),server 监听 `:3001`。
  - plist:`~/Library/LaunchAgents/com.rose.cloudcli.plist`
  - 日志:`~/Library/Logs/cloudcli.log` / `cloudcli-error.log`
- **本仓库分支**:`main` 跟踪上游 `origin`(siteboon);`rose` = 个人定制分支,推私有 fork `fork-origin`(github.com/zhaojiangang-it/claudecodeui)。
- **"安装我改的版本"** = rose 分支构建 → pack 成 tgz → 全局替换 → 重启 launchd 服务。

## rose 分支定制清单

> rebase 上游时靠这张表认出自己的改动;新增定制务必同步登记。

| 提交 | 内容 |
|---|---|
| `feat(providers): 默认模型名从 claude 配置文件解析显示`(0ca28472) | 模型选择器 Default 选项透出 ~/.claude/settings.json 解析出的真实模型名 |
| `feat(providers): 模型选择器联动 CC Switch` | 实时只读 `~/.cc-switch/cc-switch.db` 列出全部 claude 供应商(增删即时可见);选中 = 该会话经 SDK settings 注入该供应商完整 env(端点+密钥+模型映射),不动全局配置;存在 CC Switch 供应商时隐藏官方预设模型。核心文件:`server/modules/providers/list/claude/claude-cc-switch.provider.ts` |

## 一、安装定制版(可整段复制)

```bash
cd ~/code/claudecodeui

# 1) 确保工作区改动已全部 commit(打包要求干净工作区)

# 2) 版本号加 -rose 后缀,一眼区分定制版与官方版
npm version 1.37.8-rose.1 --no-git-tag-version   # 基线版本按实际改

# 3) 构建 + 打本地包
npm run build
npm pack        # 产出 cloudcli-ai-cloudcli-<版本>.tgz

# 4) 全局安装(⚠️ 必须带 --allow-scripts,见「四、关键坑」第 1 条)
npm i -g --allow-scripts=@cloudcli-ai/cloudcli,bcrypt,better-sqlite3,node-pty \
  ./cloudcli-ai-cloudcli-1.37.8-rose.1.tgz

# 5) 重启常驻服务
launchctl kickstart -k gui/$(id -u)/com.rose.cloudcli

# 6) 验证三件套(纪律:装完立即验证,别留到下次被动重启才暴露)
launchctl list | grep cloudcli                                   # 状态应为 0
lsof -i :3001 -sTCP:LISTEN                                       # 应有监听
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/  # 应 200
npm ls -g @cloudcli-ai/cloudcli --depth=0                        # 版本应带 -rose 后缀
```

- 开发期频繁改动可用 `npm link` 替代第 3-4 步(build 完直接 kickstart);日常常驻推荐 pack+install,全局包与仓库隔离。
- 桌面 App 形态:`npm run desktop:dist:mac` 出 dmg(与 launchd+浏览器用法重复,一般不需要)。

## 二、感知上游更新(三层,按需选)

| 层 | 方式 | 说明 |
|---|---|---|
| npm 发行版(主通道) | zjg-skills `/update`(deps.yaml 已登记);或 `npm view @cloudcli-ai/cloudcli version` | 与本机已装版本比对;上游发版很勤(数天一版) |
| 源码级(比发行版早) | `git fetch origin && git log main..origin/main --oneline` | 看上游未发版的新提交 |
| GitHub 通知(可选) | siteboon/claudecodeui → Watch → Custom → 只勾 Releases | 邮件提醒;已有 /update 时可不设 |

## 三、上游更新同步流程

```bash
cd ~/code/claudecodeui
git fetch origin
git checkout main && git merge --ff-only origin/main   # main 追平上游
git checkout rose && git rebase main                   # 定制提交重放到新版之上
# 解冲突后:
npm version <新上游版本>-rose.1 --no-git-tag-version
npm run build && npm pack
npm i -g --allow-scripts=@cloudcli-ai/cloudcli,bcrypt,better-sqlite3,node-pty ./新tgz
launchctl kickstart -k gui/$(id -u)/com.rose.cloudcli  # + 验证三件套
```

**两条纪律:**
1. rose 上的定制保持**小而独立的 commit**(定制集中在 `server/modules/providers/list/claude/`,是上游热区,小 commit 好解冲突、可按需丢弃);
2. **不必追每个版本**:一两周同步一次,或看到需要的功能/修复再动。

## 四、关键坑速查

1. **allowScripts 拦截**:本机 npm 的安全机制会拦依赖的 install 脚本,导致 better-sqlite3/node-pty/bcrypt 的 `.node` 原生绑定缺失、server 启动即崩。repo 内 `npm install` 和全局 `npm i -g` 都要带:
   `--allow-scripts=@cloudcli-ai/cloudcli,bcrypt,better-sqlite3,node-pty`
2. **绑定缺失修法**:`cd <目标node_modules>/better-sqlite3 && ../.bin/prebuild-install`(默认参数即可,**别加 `-r napi`**,会拼出不存在的文件名 404)。GitHub 下载不通时设 `HTTPS_PROXY=http://127.0.0.1:7994`;`~/.npm/_prebuilds` 有缓存则离线秒修。症状:`launchctl list` 显示 `- 1`、`:3001` 无监听、error 日志报 "Could not locate the bindings file"。
3. **绑定缺失是潜伏性的**:旧进程内存里持有旧绑定会一直正常跑,直到重启才崩——所以每次升级后必须立即 kickstart + 验证三件套。
4. **⚠️ /update 会覆盖定制版**:zjg-skills deps.yaml 里 cloudcli 的 `update_cmd` 直装官方 latest。装了 `-rose` 定制版后,更新请走本手册第三节(同步上游→重打包),**不要**对 cloudcli 直接跑一键 update。
