# ZCode 自定义身份兼容与启动恢复

日期：2026-11-05。维护编号：BRIDGE-ISSUE-20261105-IDIV-ZCODE-START-01。

## 原因与修复

Herdr 0.9.5的[官方实现](https://github.com/herdrdev/herdr/blob/v0.9.5/src/agent_resume.rs)仅为受支持的官方来源导出原生会话引用；custom:agent-bridge-zcode不会因为report-agent带agent-session-id就获得agent_session。包装器过去在post-registration把缺字段当作冲突而退出，留下已创建但未提交正文的r0；派工侧随后报告缺少存活的就绪包装器。测试替身原先无条件回填该字段，未覆盖实际接口形态。

- zcode-worker：仅在自身任务、原生ID、精确Pane/terminal租约及进程归属检查成立时允许Herdr缺省引用。明确的非空冲突仍拒绝；首注册和日常同Pane检查均采用相同规则。首次订阅额外校验原生快照sessionId，错会话立即本地脱离、不发stop。
- zcode-prompt：缺省Herdr引用不再单独拒绝；原生绑定回执、租约、空闲状态、脚本路径、PID及出生时间仍须通过，两次实时进程核对保持。存在不同原生引用仍拒绝。
- 测试替身增加缺字段模式，覆盖新建、已有执行观察、已建r0冷恢复和错误原生快照；不伪装Herdr官方来源。

## 业务主控安全接续

仅适用于failed/r0、没有submission或业务command、已创建原生ID与createSession ACK精确一致的任务。维护方不操作业务task/Pane，不代发正文。

1. 重新冻结当前工具源码，复核task、create ACK、初始规格及本地状态；确认没有其他worker/watcher/Relay观察者或人工续做。旧本地worker PID必须经存活及身份核对确认退出，未知或仍活跃时停止。
2. 如果旧Pane仍在但原包装器已退出，由业务主控核对精确Pane与terminal、确认仅剩无业务空壳后关闭该Pane。普通resume不会对仍存在的旧Pane盲目注入启动命令；不能以force绕过。
3. 设置该业务AGENT_BRIDGE_STATE_DIR，执行 node <bridge-root>/agent-bridge/bin/agent-bridge.js resume <task-id>，不带force。该命令恢复保存的原生ID，创建的只是本地承载Pane；已保存ID分支不调用createSession。r0的resume在原生就绪核验后会首次提交保存规格，因此它是业务投递动作，只由业务主控在规格仍有效时执行。如果需要修改正式规格，应由业务主控使用官方rework --spec-file路径并重新核验，而非手改task。
4. 若原任务或执行证据变化，停止套用此流程。后续transport unknown按官方对账处理，不重发、不将手工工作倒配为本轮。

共享Herdr/Desktop无需重启。独立外部程序同时打开相同原生会话仍属于需排除的并发风险；缺少官方原生引用不意味着可以自动认领其他Pane。

## 验证与边界

新增5项；针对性16/16。完整回归采用node --test --test-concurrency=4 test/*.test.js（agent-bridge目录）：508项，506通过、0失败、2历史跳过；离线验收8/8。首次默认并发全量有1项既有CBC子进程超时用例在落日志前超时，独立复跑4/4及限并发全量通过；未修改该CBC测试或实现，首败日志保留。

此处是实际Node包装器与隔离Herdr/Relay替身的执行测试，不是业务恢复成功或真实云端派单证明。未连接业务Relay、未操控业务Pane、未写业务task、未新建原生session、未发送正文、未操作EDA。业务task读取摘要与反馈中的早期快照不同，状态仍failed/r0；不得据此宣称所有文件自反馈起未变。create/state与反馈摘要一致。

本地日志及本轮150项源码摘要：.local/zcode-custom-identity-20261105/。此前发布清单保持原版，当前维护增量未提交推送。
