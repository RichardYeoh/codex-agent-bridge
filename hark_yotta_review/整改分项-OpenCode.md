# Hark 审核整改分项：OpenCode 执行端

主控集成补记：settle、observe、retry-failed、recover及Pane缺失取消已纳入CLI并补隔离回归；原session正式恢复后按核实的previous binding验证基线。下文的CLI待接说明属于初交阶段，最终测试以总报告为准。

日期：2026-11-04
范围：`Hark审核报告-2026-11-04.md` 附录B的 OC-01 至 OC-12，以及只读复现 `repro/OC-opencode-stalls.test.js`。本分项仅处理 OpenCode adapter、OpenCode worker、OpenCode 定向测试和接入文档；原报告及 repro 未修改。

## 分项结论

| 编号 | 结论 | 本轮证据与待集成项 |
|---|---|---|
| OC-01 | **适配器修复已完成；公共取消流程待主控集成** | Pane 缺失分支可调用 `authorizePaneLessInterrupt`。仅当任务/轮次、原生 session 与目录、Pane 租约、同 session 未闭合属主、当前桥接准入消息及两次稳定回合指纹均匹配，且无审批、表单或外来输入时授权；该函数不发送中断。正向与拒绝场景均有隔离测试。仍须由主控在“Pane 明确缺失”分支消费授权、执行取消状态更新并验证 CLI 端到端出口。 |
| OC-02 | **适配器重试能力已完成；显式 CLI 入口待主控集成** | 实现原生新 failed 终态核验、稳定 retry ID 和 `attemptNumber` journal、每轮最多2次、同 round/same prompt；lost ACK 留在 `sending`，不得换号或自动重投。只有主控显式 `resume <id> --retry-failed` 应调用。安全正向、旧失败、审批/表单、外来输入、绑定变化、次数上限及 lost ACK 均有测试。 |
| OC-03 | **未由 OpenCode 分项实现；公共 `settle` 待主控集成** | 原生晚到交付后的 `delivery_missing -> review_pending` 属公共CLI状态迁移，不应由 adapter 代写 task。文档已记载 `settle <id>` 目标契约；当前代码核查尚未发现该 CLI 命令，因此不能报告已闭环。 |
| OC-04 | **已修复** | worker 对瞬时原生API读取失败采用退避重试；连续3次失败才报告 `api_unavailable`，成功读取会复位计数。观察器启动读取失败时仍启动已登记 session 的原生 TUI，并继续重试只读观察。隔离测试分别证明一次失败不阻塞和启动时API不可用仍拉起TUI。 |
| OC-05 | **公共恢复逻辑待主控集成** | 报告所述 transport error 不应把仍在执行的任务降级为 `failed`。该修复属于公共 `recover` 生命周期，未在 OpenCode adapter 内改写。需在主控 `recoverOne` 对 OC 使用原生会话/租约证据，并保留存活 watcher/task 状态；当前公共代码复核仍可见 transport catch 写入 `failed` 的通用路径，尚不能判定已修复。 |
| OC-06 | **适配器对账已完成；`recover` 消费待主控集成** | `reconcileSubmission` 查询当前 round 的原生 Inbox 和精确 message ID，不调用 `session.prompt`。只有 journal `prepared`（请求开始前持久化）能证明 `not_sent`；`sending` 等回执不明状态且原生证据不足时返回 `unresolved`。recover 得到精确 admitted 证据后可调用 `confirmReconciledSubmission`，将对应原始/attempt journal 从 `prepared` 或 `sending` 记为 `confirmed`，不写原生状态；此后仍以当前原生 user 消息和新失败终态核验下一次显式重试。 |
| OC-07 | **回合指纹与单次安全中断已完成；有界重试待公共取消模块集成** | `turnFingerprint` 将任务、轮次、session、目录及当前桥接准入ID绑定；assistant进展保持稳定，较新的用户或shell输入使授权失败。`interrupt` 拒绝代答审批/表单、移除外来队列，且只可取消唯一的本任务排队准入。主控共取消模块仍需记录重试次数，并在每次重发 `session.interrupt` 前复核同一 fingerprint、无新审批和外来输入。 |
| OC-08 | **文档契约已补；观察窗口 CLI 待主控集成** | 文档已说明 `observe <id> --wait-timeout-ms N` 只调整观察窗口/重新附着，不重投。当前 CLI 代码未发现 `observe` 命令；现有 `--wait-timeout-ms` 只在 dispatch 入口读取，不能覆盖报告建议的恢复观察场景。 |
| OC-09 | **未由 OpenCode 分项完成；公共 worker 启动防重待主控集成** | 本分项没有新增 TUI 启动流程，也没有改公共 `resume --force`。文档记录只在确认原 worker 不存在时才允许建新 Pane，身份不符须拒绝重复启动。需要主控完成全量原生 session 定位和 CLI 正向回归；当前不能报告 OC-09 已闭环。 |
| OC-10 | **OpenCode worker 部分修复；公共启动清理待主控集成** | 观察器首个 API 查询失败不再直接退出，仍启动当前登记 session 的 TUI 并继续退避观察；worker 隔离测试通过。新建 Pane 启动失败的回滚/清理属于公共 launcher，尚待主控验证。 |
| OC-11 | **当前审查环境中的冲突不成立；跨环境共存未验证** | 原报告记录 DEBUG2 上 Herdr 官方 OpenCode 集成为 `not installed`，因此该环境没有已发生的双集成冲突。不同机器的共存行为缺少验证。文档要求接入 bridge 的 Pane 不同时加载官方集成，并明确这是未完成共存验证的操作约束，不将单机状态外推为普遍事实。 |
| OC-12 | **适配器文档与测试已更新；全链路一致性待主控集成后复核** | 文档补充瞬态 API 处理、审批/外来输入约束、失败回合显式重试、准入对账、晚到交付、观察窗口和 Pane 生命周期。新增两份 `hark-oc-*` 测试及一个既有 OpenCode 测试 fixture 更新。当前 OpenCode 定向命令41/41通过；由于 OC-03、05、08、09及 CLI 命令尚待主控接入，不能宣称附录B全部闭环。 |

## Adapter 接口与持久化约定

主控 CLI 可消费以下导出函数：

```js
authorizePaneLessInterrupt(task, { request = call })
// -> { turnFingerprint, admissionId, binding, evidence }；只授权，不执行中断

turnFingerprint(task, { request = call })
// -> 稳定的 oc-turn-v1 指纹；仅当前桥接执行仍活跃、无审批/表单/队列外输入时返回

reconcileSubmission(task, { request = call })
// -> { state: 'admitted' | 'not_sent' | 'unresolved', ... }；只读，不重投

confirmReconciledSubmission(task, evidence)
// -> { state: 'confirmed', taskId, round, sessionId, admissionId, attemptNumber, status, file, reconciledVia }
// 仅以 reconcileSubmission 返回的精确 admitted 证据更新本地 journal，不写原生状态

authorizeFailedRoundRetry(task, { attemptNumber, expectedFingerprint, request = call })
// -> { turnFingerprint, attemptNumber, admissionId, maxAttempts: 2 }

prepareFailedRoundRetry(task, { attemptNumber, expectedFingerprint, request = call })
// -> { id, attemptNumber, file, turnFingerprint }；只写本地 retry journal，不调用 saveTask

submitFailedRoundRetry(task, text, { attemptNumber, expectedFingerprint, request = call, report = publish })
// -> { id, attemptNumber, turnFingerprint }；仅从 prepared journal 投递固定ID
```

`text` 必须沿用普通 `submitWorker` 为当前任务生成的同一任务书正文/提交内容；适配器不读取或重写 `promptPath`，不另建提示词文件、不变更 round。主控应把普通 resume、recover 和 observer 保持为不重投路径；仅显式 retry 操作可先授权、准备 journal，再投递。建议 task 元数据保存 `{ round, attemptNumber, admissionId, status, turnFingerprint }`，状态至少区分 `prepared`、`sending`、`confirmed`、`uncertain`；adapter journal 是投递证据的唯一写入方，公共 CLI 负责 task 元数据、history 事件和状态迁移，避免双写竞争。若 ACK 丢失，保持原 attempt 的 `sending/uncertain`，先由 `recover` 按原 ID 对账，不生成下一 attempt ID。

## 验证记录

在 `agent-bridge` 目录运行：

```text
node --test test/opencode*.test.js test/hark-oc-*.test.js
```

结果（2026-11-04 本轮OpenCode adapter/worker回归）：44项通过，0失败，0跳过。覆盖既有 OpenCode 测试与准入回归、Pane-less授权及拒绝矩阵、当前回合指纹、队列取消限制、Inbox/message ID对账、prepared-only `not_sent` 证明、稳定失败重试ID、lost ACK阻止换号、admitted recover后本地journal确认、晚到交付结算正向核验、API失败去抖及 API 故障时启动 TUI。测试使用临时状态目录及 OpenCode/Herdr 替身，没有连接真实业务服务。

另执行 `git diff --check`，无空白错误。测试不覆盖公共 CLI 的 `settle`、`observe`、`--retry-failed`、OpenCode `recover`、worker全局 session 定位与完整 Pane-less cancel 流程；这些接口依赖主控集成后再做端到端隔离验证。
