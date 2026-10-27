> 本文件为迁移前历史交接的脱敏副本。当前工作从README.md、AGENTS.md和进度台账顶部接续，不执行旧路径或旧版本安装步骤。

# CODEX_HANDOFF · Codex + Herdr + CBC 多 Agent 协作环境

> **当前状态（Codex独立审核后，0.2.1）**：委派技能已审核并安装，两个真实任务已验收。发现5条尾部延迟提醒后，已增加原生队列合并/撤回/暂停；真实队列CRUD通过，37项回归通过。断网、限流、配额和等待超时保留会话并阻塞，不自动重派。当前审计根提醒已暂停。当前使用 [Codex审核报告](Codex审核报告.md) 与 [README](agent-bridge/README.md)。执行显示名为 `cbc`；默认复用项目Workspace。ZCode完成调查，尚未正式接入。下文保留CBC搭建阶段的原交接快照，不作为当前待办清单。

> 交接对象：Codex（主 Agent）。读完本文件即可接手，不需要重新调查搭建过程。
> 撰写时间：2026-10-27。状态细节与后续待办见 `协作环境进度台账.md`，使用说明见 `agent-bridge/README.md`。

---

## 1. 一句话状态

派工 → CBC 独立执行 → 自动通知 → Codex 验收的主链路**已端到端真实跑通**（测试 A/B/C 通过，含真实 `codex queue` 通知）。异常恢复的 5 个场景已实测 4 类，1 类只差最后结算（模型收尾慢）。剩下的主要是**你来安装委派 Skill、用 Skill 跑一次真实派工与返工**，以及是否安装可选的 Herdr 官方 Codex integration。

---

## 2. 系统结构

```
Codex CLI 0.164.0（主控）
   │  delegate-worker Skill（已写好，待你安装）
   ▼
agent-bridge（Node ≥20，无第三方依赖，${PROJECT_ROOT}\agent-bridge）
   │  herdr CLI（--session <name> …）
   ▼
Herdr 0.9.5 服务端（%APPDATA%\herdr\herdr.sock，命名会话可选）
   │  workspace / pane
   ▼
CBC CLI 2.177.0（执行 Agent，独立会话独立额度）
   │  hooks → pane report-agent（working/idle/blocked + sessionId）
   └─ 交付报告写 deliveries/round-NNN.md

完成通知：watcher 结算 → `codex queue --thread <id> --message <text>` → 你的会话
```

关键路径：

| 内容 | 绝对路径 |
|---|---|
| 协调器 | `${PROJECT_ROOT}\agent-bridge\` |
| 委派 Skill（源） | `${PROJECT_ROOT}\agent-bridge\skills\delegate-worker\` |
| 测试工程 | `${PROJECT_ROOT}\agent-bridge-test\` |
| 测试状态与证据 | `${PROJECT_ROOT}\agent-bridge\test-artifacts\state\` |
| 生产状态（默认） | `%LOCALAPPDATA%\agent-bridge\` |
| 进度台账 | `${PROJECT_ROOT}\协作环境进度台账.md` |
| 使用/扩展/维护说明 | `${PROJECT_ROOT}\agent-bridge\README.md` |
| 配置备份 | `${PROJECT_ROOT}\agent-bridge\backups\` |

已改动的全局配置只有一处：`${USERPROFILE}\.codebuddy\settings.json` 增加了 8 类 hooks（指向本仓库 `hooks/herdr-codebuddy.js`），安装前原文已备份在 `backups/2026-10-26T14-33-28-837Z-install/`。**Codex 侧 `~/.codex` 零写入。**

---

## 3. 已完成的工作

| 项 | 内容 |
|---|---|
| 环境勘察 | Herdr 0.9.5 安装并常驻；CBC 修复并升级（当时 2.176.0，现 2.177.0）；Codex 0.164.0；Node 24.14.0 |
| CBC 状态检测 | 自研 hook（70 行）：SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/Stop/Notification/SessionEnd → `pane report-agent` + `--agent-session-id` |
| 任务控制 | `dispatch / rework / resume / cancel / accept / status / read / recover / list / agents` |
| 派工方式 | 任务书落盘（`round-NNN-prompt.md`）+ 终端只发一行指针，避免长文本被终端折行破坏 |
| 交付契约 | 必须写 `deliveries/round-NNN.md`；缺失即 `delivery_missing`，不采信口头完成 |
| 异步 | 每任务一个独立 watcher 进程，`agent wait --until idle/done/blocked` 事件驱动，不轮询 |
| 通知 | `codex queue --thread --message`，按 `轮次:状态:completionSeq` 幂等去重 |
| 恢复 | `recover` 重启 watcher / 用保存的 CBC session ID 重建 worker / 补发通知；`resume` 重投本轮 |
| 扩展入口 | `lib/agents.js` 注册表（新增 Agent 只改一处），`agent-bridge agents` 可查 |
| 单元测试 | `agent-bridge/test/`，`npm test` 12/12 通过 |
| Herdr 官方 skill | 已装 `~/.agents/skills/herdr/SKILL.md` |

---

## 4. 实测结果（真实证据）

| 测试 | 结果 | 关键证据 |
|---|---|---|
| A 基础委派 | ✅ | `test-e2e` r1：建 workspace → 启 CBC → 信任确认 → 派工 → 交付报告 |
| B 连续返工 | ✅ | 第 1 轮故意 2 处缺陷 → `node --test acceptance.test.js` 退出码 1 → 返工回同一会话 → 第 2 轮补齐后退出码 0，报告显式声明继承第 1 轮文件 |
| C 异步与通知 | ✅ 真实 | `test-c-notify`：dispatch 11.3 s 返回；CBC 53 s 完成；01:10:28 结算 `review_pending`；01:10:29 `codex queue` 投递成功；**Codex 会话自动开始验收**（复跑 2/2、3/3 通过） |
| D-1 无交付 | ✅ | `test-d-missing` → `delivery_missing` + 通知已发 |
| D-2 取消 | ✅ | `test-d-cancel` → `cancelled`，watcher 不再覆盖；`rework` 对 cancelled 正确拒绝 |
| D-3 watcher 死亡 | ✅ | 手动 kill watcher → `recover` 重启 → 正常结算 → 再次 `recover` 无重复通知（桩计数 1→1） |
| D-4 通知投递失败 | ✅ | 通知入口指向不存在文件 → `notification.pending` 且记录 MODULE_NOT_FOUND → 修复入口后 `recover` 补发成功 → 再 `recover` 幂等 |
| D-5 Herdr 服务重启 | ✅ | 派发后 `server stop` → watcher 报 `EmptyResponse` → 任务 `failed` → `resume` 用原 session ID 在新 pane 重建 → 第 2 轮读取成功、交付报告已写（报告证实它知道 round-001 无交付）→ 01:55:27 结算 `review_pending`、通知已发。**完整链路闭环** |
| E 完整闭环（自动派工+返工） | ⏳ 交给你 | 需要你先安装 Skill，再用自然语言派一次真实任务（建议第一条故意留缺陷，验证 rework） |

---

## 5. 本次修复的缺陷（环境暴露的真实问题）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | Codex 在会话里执行 `accept` 报 `EPERM: open task.json.<pid>.<rand>.tmp`，状态写不进去 | 原子写把「清理 backup 失败」也当成写入失败并回滚；Windows 上清除刚创建/刚删除的文件可能被瞬时拒绝 | `lib/util.js`：瞬时错误（EPERM/EACCES/EBUSY）重试、交换失败退回覆盖写、清理失败不再回滚。沙箱内 60 次压测 0 失败、0 残留 |
| 2 | 新的 Herdr 命名会话派工必失败：`server_not_running` | `herdr status server` 在服务未运行时**也返回退出码 0**，`ensureServer` 误判 | `lib/herdr.js`：改为检查输出 `status: running`，等待 15 s，失败时提示 `herdr session attach <name>`。已实测「停止 → ensureServer → 自动拉起」 |
| 3 | 任务 `failed` 后 `recover` 静默无动作 | `recover` 只对 `running` 重建 worker | 现在会明确返回 `run \`resume <id>\` to retry in the same CBC session` |

---

## 6. 你要做的三件事

### 6.1 安装并验证 Skill

```powershell
cd ${PROJECT_ROOT}\agent-bridge
node scripts/install.js install     # 合并 hooks（幂等）+ 复制 skills 到 ~/.agents/skills
```

然后在新会话里确认 `delegate-worker` 与 `herdr` 两个技能可见。要点：技能装到 `~/.agents/skills`（不写 `~/.codex`）；若你的 Codex 只认 `~/.codex/skills`，把
`${USERPROFILE}\.agents\skills\delegate-worker` 复制过去即可（用户已授权你用这个技能，但**改 `~/.codex` 仍需他点头**）。

### 6.2 跑一次真实闭环（测试 E）

建议流程：先用 `delegate-worker` 派一个"故意留缺陷"的小任务 → 收到通知 → 自己复跑验收命令判不过 → `rework` 写具体缺陷与验收命令 → 第 2 轮通过 → `accept`。这就是任务书里的测试 E。

### 6.3 决定是否安装 Herdr 官方 Codex integration

`herdr integration install codex` 会写 `~/.codex/herdr-agent-state.ps1` 与 `config.toml`，与「Codex 侧只读」约定冲突。
**不装也能跑完整闭环**（通知走 `codex queue`）。装了的好处只是 Herdr 面板能看到 Codex 自身的 working/idle 状态。要装请先向用户确认，并自行备份。

---

## 7. 快速验收命令

```powershell
cd ${PROJECT_ROOT}\agent-bridge
npm test                                     # 12/12

$env:AGENT_BRIDGE_STATE_DIR="${PROJECT_ROOT}\agent-bridge\test-artifacts\state"
node bin/agent-bridge.js list
node bin/agent-bridge.js status test-c-notify
node bin/agent-bridge.js status test-d-server2
node bin/agent-bridge.js agents
```

Herdr 现场：

```powershell
$h="$env:LOCALAPPDATA\Programs\Herdr\bin\herdr.exe"
& $h session list
& $h --session agent-bridge-test agent list
& $h --session agent-bridge-d5 agent read w2:p1 --source recent-unwrapped --lines 60
```

---

## 8. 已知限制（不要当 bug 反复查）

1. **CBC 被强杀且未触发 Stop hook** 时 pane 可能停在 `working`，watcher 会一直等；处理方式 `cancel` 或关 pane 后 `resume`。
2. **不做进度轮询**：只有终态事件；要看过程用 `read` 或看 Herdr 面板。
3. **通知的 thread 自动探测未验证**：`CODEX_THREAD_ID` / pane agent_session 两种来源都未在真实 Codex 会话里验证过；显式 `--codex-thread` 已验证可用（本项目测试就用它）。
4. **模型侧延迟**：2026-10-27 上午 GLM-5.3 收尾明显变慢（单任务 5–10 分钟），会造成"看起来卡住"。判断依据：`agent read` 里仍在 streaming，且 `credits` 在涨。
5. **测试 pane 尚未清理**（用户要求本项目收尾后再关）：`agent-bridge-test` 会话下有 w1/w3/w4/w5/w6/w7/w8/w9/wA/wB 等测试 workspace，`agent-bridge-d5` 会话下有 w1/w2。
6. **单任务串行**：同时只跑一个外包任务，避免争用工作目录与 CBC 额度。
7. **本次测试消耗**：Codex 侧约 3 轮（≈5% 5h 额度）；CBC 侧约 6 个任务（每个 8–15 credits）。

---

## 9. 边界与约定（务必遵守）

- 不改 `${USERPROFILE}\.codex`（只读），除非用户明确授权。
- 派工任务书必须含可执行验收命令；验收以真实输出为准。
- 返工要求必须点名缺陷与验收命令，不写"再完善一下"。
- 一次只跑一个外包任务；异常先看 `task.json` + `events.ndjson` + watcher 日志，再动代码。
