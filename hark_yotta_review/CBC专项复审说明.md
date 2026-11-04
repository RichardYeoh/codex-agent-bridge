# CBC 专项复审说明

日期：2026-11-04。范围：CBC投递、回合归属、观察、恢复与收口；其他执行端仅作公共路径回归。未提交、未推送，未处理业务Agent消息或操作业务任务。

## 审核结论

本轮已完成CBC专项实现与验证，可交Hark独立复审。新提交采用精确原生回合证明，真实验证覆盖派工、同会话返工、丢失回执、关闭后原ID恢复及真实429阻塞。不能据此声称全部故障场景、共享服务重启恢复或任意人工并发操作均可靠。

现有目录只有一份正式Hark原始审核报告；整改表及MC039补修记录不是独立的第二轮审查结论。此次以实际代码和实机结果为准，不将历史计划视为完成证据。

## 修复内容

| 问题 | 处理及主要文件 |
|---|---|
| 同task/round Hook不证明实际提交正文，人工续做可能被倒配旧任务 | `lib/cbc-turn.js`核对attempt、任务书SHA、原生用户指针、session/cwd/Pane/terminal/租约；后续输入标记superseded。Hook只记录摘要和受限原生历史指针 |
| CBC实际Hook prompt与原生记录不相同 | 不做模糊文本匹配；逐字核对原生JSONL中attempt后的第一条用户消息，与Hook边界交叉证明。实测发现并修复 |
| `pane.run`成功后ACK丢失，需要人工恢复 | 不确定提交自动启动只读观察；精确输入和进程证明成立后更新任务回执，原uncertain journal保留。`bin/agent-bridge.js`、watcher |
| 发送者崩溃留在sending，恢复后卡住 | sending和uncertain均可由原生证明转observed；无证明时保存submission_unknown/uncertain，不重投 |
| 旧idle快照、早期Stop可能误结算 | CBC以实时状态及稳定state_change_seq为准；Stop后仍有同轮工具活动时继续观察；结算前再次读证据，accept前再核对 |
| 进程短暂读取失败立即丢失观察 | `lib/cbc-observation.js`对读取超时等故障最多重试3次，身份不符或访问拒绝立即停止，保留processProofCode |
| Pane/terminal丢失可掩盖仍活着的原CBC进程 | 缺少Herdr原生引用时额外核对已记录进程PID是否仍活着；仍存活不创建第二执行端或确认取消。上下文冷恢复携带前一执行端证明。当前轮证明优先于前一轮 |
| 每次轮询全读并解析历史 | `lib/cbc-evidence-cache.js`按文件身份和追加位置缓存，未变化时不重读，追加只解析新完整行；缩小、替换、坏完整行、超限拒绝结算 |
| 真实429措辞未分类，被记成delivery_missing | `lib/blocker.js`补充`429 usage exceeds frequency limit`，以真实现场和隔离用例验证为rate_limit；不自动换模型或重投 |
| 迟到报告与当前执行缺少交叉核对 | `task-recovery.settle`核对精确Stop及当前进程或已关闭执行端证明，只进入review_pending |

未重写协调器或替换执行Agent。已有OC/ZCode/AGY源码改动保留；一处公共watcher变更曾影响ZCode回归，已将新的实时状态判据限定在CBC路径，相关回归与全套回归通过。

## 实机验证

环境：Windows原生，Herdr 0.9.5，CBC 2.179.3；独立工程和状态根均位于`.local/cbc-focus-20261104/`。复用维护Workspace，未新建Workspace，主控Pane未改变。所有测试沿同一CBC原生会话，共5个桥接任务、8轮输入。

| 验证 | 实际结果 |
|---|---|
| 正常小型开发、独立断言 | 完成数值相加函数与产物，主控独立执行断言；通过后accept |
| 同一任务返工 | 同session保留记忆标记，按新规格修改；原轮报告保留，新轮独立报告通过 |
| 新协议首次真实输入 | 首次发现Hook hash不等于指针，保留submission_unknown；通过正式`recover --cbc-transcript`恢复review_pending，无重发 |
| 修复后自动回合 | 新协议R2自动从原生接纳到Stop、review_pending及通知入队，无人工对账 |
| 真投递后故意丢失ACK | 仅隔离测试的调用方丢弃一次真实成功回执；桥接自动对账完成，原attempt仍uncertain；精确UserPromptSubmit只有1条 |
| accept、关闭Pane、同原生ID冷恢复 | 任务产物、记忆标记、原native ID和新Pane均核对；一次观察进程读取失败经官方resume恢复，仅恢复观察 |
| 最后一次冷恢复遇真实429 | 原生确切输入与Stop存在，无报告。初次delivery_missing暴露分类缺口；补修后官方observe只读重核为blocked/rate_limit，没有再次发送任务 |
| 真实限流任务取消收口 | ack后cancel保留cancel_pending；核对本次空闲执行端并关闭，仅由官方recover确认cancelled，原生历史保留 |
| 清理与通知 | 4个测试任务accepted，限流任务cancelled，watcher均为空；本轮创建的测试Pane全部关闭。完成/阻塞通知的队列回执可核对，不将queue接受等同于无人值守消费 |

真实断网、真实额度耗尽、危险审批、共享Herdr重启均未主动制造。限流服务端文字不能据此进一步推断账户配额产品类型或服务恢复时间。

## 自动回归

最终执行：

```powershell
npm test
npm run test:e2e
npm run check:publication
git diff --check
```

- `npm test`：503项，501通过，0失败，2跳过。跳过项为原有归档Tunnel检查和本机无权限创建符号链接的缓存测试；没有更改系统权限来消除跳过。
- `npm run test:e2e`：既有离线交付/布局验收8/8；不是此次CBC原生实测的替代证据。
- 新增测试覆盖原生历史绑定、后续输入、部分UTF-8写入、缓存增长/替换、迟到交付、进程迁移防误判、sending崩溃窗、回执丢失、429/配额/断网分类和不自动重发。
- watcher集成测试运行真实Node CLI及状态机，Herdr、模型输入、进程读取和通知使用隔离替身；不得称为云端或原生模型实测。
- 语法检查和公开候选检查通过，差异检查无whitespace错误。Windows行尾提示不等于测试失败。

最终日志：`.local/cbc-focus-20261104/final-npm-test-02.log`、`final-e2e.log`。此前失败与修复过程日志保留，没有覆盖成成功记录。

## 仍需复审的边界

1. 旧业务任务不会被批量升级。新轮次启用精确协议，旧未知提交走显式原生历史对账。旧观察路径不等同于新协议已获全部证明。
2. Herdr 0.9.5不为CBC/custom来源提供官方agent_session。登记原进程仍活着时已防止因Pane丢失而重复启动；对外部手工恢复成新进程、同时改变Pane/terminal且缺少独立身份的情况，不能凭旧PID死亡证明没有同ID新执行者。不得在桥接仍管理该session时另起同ID写入者；共享服务重启后的认领不在本轮实机通过范围。
3. 当前Hook定义没有启用StopFailure。若429/断网没有Stop，只能有限等待后保留不确定/blocked；不能伪造失败终态或自动续发。
4. Herdr输入API没有原子身份/审批CAS。最后一次检查到输入/落盘之间仍有并发窗口；同一TUI人工接管须协调，不盲发快捷键。
5. JSONL增量缓存依赖原生追加日志语义，文件最大64MiB，最多8文件。更大历史或重写导致的拒绝须显式处理；缓存不是防恶意修改的安全存储。未变化文件复用和追加解析已验证，不宣称任意日志重写均可无损继续。
6. Pane关闭不证明脱离进程的后台仿真全部结束。通知队列没有跨进程事务，需保留ack/去重机制。

## 文件保留与接续

本轮开始保存`baseline/working.patch`、`baseline/status.txt`及236文件SHA清单；最终差异清单另存`.local/cbc-focus-20261104/change-audit.json`。原有未提交文件未回退、没有删除。

工程内Skill源已更新，安装副本和全局Hook配置未写入。日常恢复说明见[精确回合与恢复](../docs/CBC精确回合与恢复.md)。社区调查见[Herdr社区与CBC接口评估](../docs/Herdr社区与CBC接口评估.md)：尚无已证实可直接替换的完整方案，未安装、启用Gateway或建立公网通道。

一项新增测试首次运行误写到默认状态根`%LOCALAPPDATA%/agent-bridge/tasks/cbc-late-settle-1/task.json`，fixture已修正，后续均使用隔离状态根。工具策略曾拒绝此前删除，未绕过。取得用户本轮明确授权后，仅将这个已核验目录移入`.local/cbc-focus-20261104/archived-misplaced-fixture/`，移动前后SHA-256一致，原路径已不存在，文件可恢复。归档回执位于同目录`archive-receipt.json`。本项测试进程和Pane已收口。

Hark复审应读取当前工作树（包括未跟踪的新文件）、本报告及最新`复审源码清单.json`，重点检查输入与Stop归属、失联不重发、文件缓存假设、身份恢复边界及旧协议兼容；不得操作业务任务来替代独立测试。

## 发布补记

2026-11-04用户授权提交推送。发布前复跑全量501通过/2跳过/0失败、离线8/8；清理两份测试文件的末尾空行及报告尾随空格，无逻辑变化。历史复审清单保留当时本机字节摘要；Git暂存区统一LF后的150项摘要另存`发布源码清单.json`，远端复审以该发布清单和Git提交为准。原始Hark报告和复现材料继续仅留本机，Hark独立复审尚未完成。
