# 0.3.0集成验证证据

## 自动验证

`automated-summary.json`记录62项回归与原8项交付验收全部通过。回归包括结构化规格、原型键拒绝、完整/差量提示、实际会话与终端身份、租约转移、压缩回执、官方域名限制、缺登录失败、KICKED不争抢、RPC不确定不重发、当前命令终态及快照缺口拒绝。协议子集按固定源码与依赖重建后SHA256一致。

8项验收验证原交付工程，不替代下面的真实Agent执行。网络、限流、配额与等待超时的故障注入沿用公共回归；没有真实耗尽账户配额。

## 真实CBC验证

两个独立任务在同一实际CBC会话与Herdr Pane运行。首任务发送完整规格，第二任务采用差量，未重复给出记忆测试字符串，却正确完成对应文件；独立验收通过后均accepted。首、次提示分别2531和1926字符，该数字仅反映当次任务文件，不等同于精确的计费token节省比例。

同时验证CBC原生--append-system-prompt可接受稳定规则。相同Agent显示名并未被当作会话身份证据；使用存活terminal与Hook session回执关联。系统不承诺自动续接已关闭Pane的跨任务上下文。

## 真实ZCode验证

`live-summary.json`保留脱敏后的结果，原始链接、session、命令日志和快照只存本机.local。

| 项目 | 实际结果 |
|---|---|
| 原生连接 | 通过官方Relay取得bootstrap、Host RPC hello与Project服务，无浏览器操作 |
| Start Plan文本 | GLM-5.3-Flash/low收到完整assistantText回复；不将用户输入中的期望字符串当作成功 |
| 文件任务 | formatId生成并通过主控独立验收 |
| 单次权限接管 | edit模式的固定验收命令暂停；核对具体命令后显式allowOnce，不授予全局或项目权限 |
| Pane恢复 | 关闭已核实测试适配Pane后重建，session保持一致，第一轮命令未重发 |
| 连续返工 | 第二轮修改大小写行为，第三轮使用delta并验证会话记忆，三轮使用三个独立commandId |
| 结果验收 | FORMAT_PASS、FORMAT_REWORK_PASS、CONTEXT_DELTA_PASS分别由主控在任务cwd运行并通过，最终accepted |
| 命令查询 | 原生query回读第三轮已接收命令，不发送新的写命令 |
| 运行中取消 | 等到sendText ACK后cancel，权威turn为completedInterrupted、canStop=false、activeWorks=0，任务cancelled |
| 活跃执行恢复后取消 | 在运行中关闭适配Pane、重建并恢复同session/同round，未重发任务；恢复期间Escape仍可中断，权威activeWorks=0 |

首个纯文本实验曾因未指定reasoningLevel进入invalid_model_request；补齐low后成功。独立CLI补配置路径后仍提示选择模型；独立app-server显式Start Plan/Flash报modelUnavailable。这些失败保留在私有研究材料，不改记为通过。

## 证据范围

ZCode Desktop 3.16.3、Agent CLI 0.17.0、Node.js 24.14.0、Herdr 0.9.5；官方源码固定提交见vendor/zcode/sources.json。真实测试采用独立临时业务目录并复用主项目Herdr Workspace，没有操作已有用户聊天，也未修改安装包。

未验证：新版Codex队列空闲自动开轮、整机重启、长期无人值守、全部权限分支与真实配额耗尽。当前结论支持人工监督下的日常委派，不扩张为所有故障下严格exactly-once或全面无人值守稳定。
