> 下文保留0.2.1独立审核结论，公开副本已脱敏。当前版本0.3.0另完成结构化任务规则、真实会话差量与ZCode Desktop执行端，证据见[evidence/2026-10-27-integration](evidence/2026-10-27-integration/README.md)，路线选择见[ZCode接入说明](docs/ZCode接入与方案选择.md)。历史“尚未接入”仅对应当时阶段；新版空闲唤醒等未验证项仍保留。

# Codex + Herdr + CBC 独立审核报告

审核日期：2026-10-27。当前协调器版本：0.2.1。

## 1. 审核结论

CBC 原交付具备可复用的主链路，无需重新搭建。经独立审核、修复和实测，当前版本已满足本机正常委派、异步通知、同会话连续返工、人工验收以及本次验证的异常恢复要求。Codex 保留规划、任务控制和最终验收权；执行 Agent 仅提交交付，完成不直接等于验收通过。

审核收尾阶段另观察到5条延迟提醒。核对结果为6个不同执行事件各入队一次，第一条用于真实自动唤醒，另外5条在任务已验收后陆续消费；未发现同一任务被自动重复执行。该问题属于P2通知质量缺陷，会消耗主控轮次，不能仅以业务幂等认为已解决。0.2.1已改为原生队列合并、更新与撤回，当前可用于人工监督下的日常协作；长期无人值守及所有升级兼容仍未验证。

默认组织改为一个项目复用一个 Workspace：调用 Pane 明确时创建同级 Pane；仅有 Workspace 信息时创建 Tab；独立项目、Worktree或明确隔离才使用 `--new-workspace`。执行 Agent 显示名为 `cbc`，任务ID独立保存。本次未搬动正在返工的任务，而是在后续任务验证新策略。

环境为原生 Windows：Herdr 0.9.5、CBC 2.177.0、Codex 0.164.0、Node.js 24.14.0；控制命令经 PowerShell 7.6.8，Herdr 本轮使用其原有 Windows PowerShell Pane。没有迁移到 WSL，没有修改 ZCode 安装包或 Codex 全局配置。

## 2. 发现及修复

| 重要性 | 问题与原因 | 修复与验证依据 |
|---|---|---|
| P1 | 每次派工无条件创建 Workspace，与项目组织方式不符 | 新增位置策略，优先同级Pane/同Workspace Tab；真实新任务未增加Workspace，恢复也留在原Workspace |
| P1 | 原提交超时后自动再发，不能排除首条已被接收 | 保存提交阶段，取消自动重发；不确定状态保留为submission_unknown；快速完成与超时不重发回归通过 |
| P1 | 会话ID只按Pane匹配，不同Herdr服务可能有相同Pane ID | 按taskId、Herdr服务、Pane、启动时间匹配；核对terminal ID、Agent类型与独立名称；跨服务关联回归通过 |
| P1 | watcher与主命令同时写task.json，缺少串行化 | 增加任务写锁及轮次检查；默认生产状态根内串行派工；并发状态更新回归通过 |
| P1 | 原“原子写”先移走旧文件，失败时覆盖写，存在不可读或部分写窗口 | 重试直接原子替换，失败保留旧状态；故障注入验证未截断原文件 |
| P1 | 队列入队被称为已送达，缺少消费确认 | 区分sending/queued/acknowledged；新增ack和事件key；实际空闲自动开轮及确认通过 |
| P1 | 恢复时将连接错误当成worker已消失，可能重投仍在执行的任务 | recover先对账，不因连接错误自动重发；明确resume/force重试；不确定投递需显式补发 |
| P2 | CBC由Hook识别，Herdr原生agent prompt拒绝其为活动Agent | 实测拒绝后，将CBC提交方式保留为经身份核对的Pane输入；不再尝试原生启动类型 |
| P2 | Hook的message参数可能落在恢复命令分隔符之后；上报进程脱离后可能乱序 | 修正参数顺序与SessionEnd参数，等待上报完成；正常生命周期已实测，权限弹窗仍待专项验证 |
| P2 | 初次信任、启动中断时未保留初始任务；通知缺目标不能按文档补绑 | 启动前保存initial-request；新增recover --codex-thread；明确blocked/failed/不确定提交等状态 |
| P2 | 用任务ID作显示名，且宣称注册一项即可完成所有Agent接入 | 显示名改为cbc，冲突仅加短编号；补充真实适配契约，ZCode不注册未实现入口 |
| P2 | ack只更新本地状态，无法撤回此前已排队的旧提醒，出现5条验收后延迟消息 | 通过原生queue CRUD维护每状态根/线程一条合并提醒，ack及生命周期变更撤回失效项；真实6轮仅add一次、update五次，ack后为0 |
| P2 | 无界等待不能及时暴露断网/配额墙，同轮恢复后再次阻塞可能复用旧key | 默认30分钟监听上限；明确错误映射blocked，保留会话和轮次；每次结算递增事件标识，禁止自动重派，4类watcher故障注入通过 |

用户已授权安装的 `delegate-worker` 经修订后安装到 `~/.agents/skills/delegate-worker`，已进入当前技能目录并用于派工。官方Herdr Skill保持独立且未修改。安装器增加仅安装技能的命令，避免重复改写CBC配置；技能校验通过。PyYAML仅安装在审计目录，未改全局Python。

## 3. 独立验证结果

| 项目 | 结果 | 证据与范围 |
|---|---|---|
| 原单元测试 | 12/12通过 | 修改前独立复跑，与CBC原报告区分 |
| 当前自动回归 | 37/37通过 | [0.2.1回归日志](evidence/2026-10-27/notification-fix/unit-tests.log)，含队列合并撤回、暂停隔离、丢失响应及4类watcher阻塞恢复；此前0.2.0为27/27 |
| A 正常派工 | 通过 | `audit-layout-001` 首轮真实生成证明文件，执行原项目7项测试；主控独立检查 |
| B 连续返工 | 通过 | `audit-port-001` 实际执行轮次2/3/4，主控验收依次2/7、5/7、7/7；同session、同terminal，contextMarker均为garnet |
| C 异步及自动唤醒 | 通过 | 派工启动后返回；通知入队后主控结束当前轮，队列实际启动下一轮，并运行ack和验收；验收后继续后续任务 |
| D watcher退出 | 通过 | 第4轮执行中终止已核对身份的watcher PID 57672；recover恢复监听，未重发任务，最终结算通知正常 |
| D 执行Pane关闭 | 通过 | 关闭本次创建的w3:p2；按原CBC session恢复为w3:p3，仍在w3，随后继续返工 |
| D 重复恢复 | 通过 | 接受后重复recover，通知记录未增加；单元测试另覆盖发送失败、补发和不确定发送 |
| E 技能及项目组织 | 通过本轮验证范围 | 技能已发现；复用w3创建Tab，同级Pane实际创建/关闭通过，均未依赖UI焦点 |
| 最终验收 | 8/8通过 | [final-e2e-tests.log](evidence/2026-10-27/final-e2e-tests.log)，两个真实任务均accepted |
| 原生队列CRUD | 通过 | [实际结果](evidence/2026-10-27/notification-fix/native-queue-result.json)：6轮1次add、5次update，ack撤回，pause/resume/accept正常；保留其他消息，实验结束队列0 |
| 断网/限流/配额/超时 | 故障注入通过 | watcher子进程实际走结算路径，blocked、session与轮次保留、不重发；同轮再次阻塞产生新key。未实际断开整机网络或耗尽账号额度 |

测试期间另发现执行质量问题：恢复后的CBC沿用了旧测试标记，并以改写期望值的命令自述通过。主控固定验收文件识别到不符，要求原会话再次返工，最终1/1与7/7通过。这验证了独立验收的必要性，不能仅依据报告内容接受任务。

端口测试文件SHA256始终为 `19E3F26A490A5B61D84B06B84632033074E2AA3A5B0C9C021BE4E3BF79746CB3`。工作位置前后快照显示Workspace集合未增加，后续恢复仍复用w3。

本轮未全面复验整机/Herdr服务重启、所有权限弹窗、取消分支或多主控并发；CBC原历史报告不替代新版本的独立验证。强杀CBC而未产生结束事件时，默认监听上限后进入blocked，原执行可能仍在继续，需要核对现场。队列与本地状态不存在跨进程事务，不承诺严格exactly-once；已经进入执行的消息也无法撤回。0.2.0旧投递路径的空闲自动唤醒已真实验证；0.2.1原生队列CRUD已在主控活动期间真实验证，本次未额外启动模型轮来重复验证其空闲消费行为。

## 4. 实际使用

1. 打开Herdr，在项目Workspace中启动/恢复Codex，直接用自然语言要求将明确任务交给CBC。
2. Codex使用委派技能编写任务书并派工，不要求用户另开CBC或watcher。有调用Pane时复用其Workspace；daemon未继承环境时显式选择已核实的Workspace/Pane。
3. 完成通知到达后，Codex确认轮次、运行ack、检查文件并执行原验收命令。通过后accept并继续主计划；不通过时以具体缺陷和命令rework同一会话。
4. 需要人工接管时按task.json中的服务和Pane定位；暂停或取消须确认实际状态。故障先recover，明确需要重新执行时再resume；force可能重投任务，不能用于盲目重试。

可直接使用的命令、位置选项、信任设置、恢复和安装说明见 [README](agent-bridge/README.md)。当前生产状态默认在 `%LOCALAPPDATA%\agent-bridge`，本次测试使用独立审计状态根，不与生产任务混写。

需要停止提醒时，在普通终端设置原状态根及线程ID，运行 `notifications pause --codex-thread <线程ID>`，无需关闭Herdr或Codex。当前审计状态根已暂停，两个真实任务保持accepted；恢复使用 `notifications pending` 检查，再 `notifications resume`。暂停只影响该状态根/线程的提醒，不停止执行Agent，不影响其他状态根。

执行Agent出现网络、限流、额度错误时保留原会话并进入blocked，不自动重派。普通resume只恢复存活Pane监听；确需发送继续要求时使用同会话rework。Codex自身碰到断网或配额墙时不能保证即时验收，交付仍落盘，可从普通终端暂停提醒。通知服务不可用时本地pending，响应不确定时uncertain；恢复后显式reconcile，不引入无限重试循环，也不控制CBC CLI内部已有的网络重试。

## 5. Codex配额与职责

本轮由CBC完成两组任务、共6个实际执行轮次，使用CBC平台模型入口，未通过用户DeepSeek API执行任务。写入、测试和报告整理可交给CBC；规划、写入范围、核心决策、独立验收与后续推进仍由Codex负责。

启动探测与状态等待由确定性程序执行，watcher等待Herdr事件，不需要模型循环轮询。默认只运行一个执行任务；不同显式状态根不共享锁。主控派工和验收仍有配额成本，本次包含首次审核和故障注入，未测量可复用的节省比例。不能把派工描述为完全不占Codex额度。

0.2.1撤回尚未执行的失效提醒，减少尾部空转轮次；这与本地任务幂等属于不同保证。原生队列接口在Codex 0.164.0验证，属于experimental能力，升级须复验。不支持时保留本地pending，不退回旧不可撤回投递。新增固定运行依赖ws@8.22.0及package-lock，未改Codex全局配置或重启daemon。

## 6. ZCode调查

官方源码固定在commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`。本机内置Agent CLI为0.17.0。精选源码保存在 [zcode-evidence](evidence/2026-10-27/zcode-evidence)，实验及结果在 [zcode-probe](evidence/2026-10-27/zcode-probe)。

| 路线 | 判断 | 登录态、会话及权益 | 维护成本与顺序 |
|---|---|---|---|
| A 复用正在运行的Desktop Host | 已确认真实Host和app-server进程；未确认可供外部程序直接连接的本地控制入口 | 官方手机远控可附着已有Host/CLI与任务，但需配对与授权；未验证程序化客户端及套餐权益 | 直接接管内部MessagePort成本高；若复用桌面权益优先，先调查官方远控授权路径，暂不正式接入 |
| B 独立app-server | 已完成真实协议控制与冷恢复实验，是协调器后续最清晰的技术入口 | 独立隔离配置未继承桌面认证；模型发送因缺有效模型选择失败；不能据此认定桌面套餐可复用 | 协议适配成本中等，推荐作为下一步最小开发验证路线；先解决正式Provider/认证来源 |
| C 独立CLI | `app-server`入口已证实不需要TUI；本阶段未继续修复旧TUI/模型选择报错 | 独立CLI仍需正式配置模型和认证，不能从桌面已登录推定可用 | 作为备选，不围绕旧报错反复修补 |

分类依据：

- **官方公开产品能力**：桌面、CLI入口、手机远控、Subagents和ADE工具。Subagents/ADE属于Agent内功能，不是外部调度现有桌面任务的保证。
- **官方内部可适配接口**：窗口级Host通过Electron MessagePort RPC连接服务；workspaceKey隔离的app-server通过stdio NDJSON收发V4命令和投影。源码提供ProtocolClient/Transport实现，但未核实独立稳定SDK的发布和兼容承诺。
- **尚未验证方案**：外部附着现有桌面私有MessagePort、复用受保护登录材料、将远程Source server接口直接当成本机Desktop API。未把这些方案宣称为可用。

独立实验使用桌面携带的Electron Node运行 `resources/glm/zcode.cjs app-server --stdio`，指定正式内置Provider配置文件路径，数据与用户配置全部隔离到审计目录。真实结果为：runtime/capabilities成功；createSession accepted；同commandId重试返回duplicate及同sessionId；订阅收到ConversationSnapshot；stop accepted；退出后新进程按同sessionId订阅，收到cold恢复快照。sendText未完成模型执行，返回缺少provider-qualified模型选择。实验没有复制桌面凭据，没有修改安装包。

关键实施点：V4 ACK不是生成完成；状态以对应snapshot/delta为准。重试复用commandId，处理revision/logEpoch与订阅恢复。createSession过程中存在Host反向请求session/requestRuntimePreferences，省略回调会超时，补齐后实测创建成功。Provider和凭据有所属Environment/Host边界，不能仅因共享安装目录而直接继承。

主要依据：[当前协议](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/zcode-protocol.md)、[Desktop集成](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/zcode-agent-app-integration.md)、[远控架构](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/web-remote-control/web-remote-control-architecture.md)、[Host实现](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/src/main/desktopHostProcess.ts)、[Subagents](https://zcode.z.ai/cn/docs/subagents)、[ADE工具](https://zcode.z.ai/cn/docs/ADE-tools)。

## 7. 后续接入准备

保留现有业务编排，已将位置管理、Agent显示名、真实识别类型、提交方式及身份关联分开。接口语义和实际扩展条件见 [执行Agent适配契约](agent-bridge/docs/adapter-contract.md)，没有提前实现不确定的ZCode控制入口。

最小下一步为：确认正式认证/Provider来源及对应权益；新增一个薄的ZCode worker适配程序，管理app-server、Host回调、V4命令及状态投影；将其会话和终态映射到现有Herdr承载；登记启动/恢复描述；复用现有交付、通知、返工和验收。若选择直接Desktop Host，先验证官方远控客户端授权，再决定传输适配，不能只增加一个注册表名称。

变更前源码快照位于 [baseline](evidence/2026-10-27/baseline)。原CBC交接仍保留，当前事实以本报告、源代码和独立证据为准。
