# Antigravity CLI接入与验证

## 结论与运行方式

0.4.0新增agy执行端，采用官方Antigravity CLI 1.4.7原生交互界面。Herdr Pane直接显示对话、工具执行和审批，Codex继续负责规划、派工、独立验收及接续。CBC和ZCode的执行路线保持原有实现。

启动前进行一次官方stream-json初始化，只取得或核验conversation_id，不发送用户提示或模型任务；随后关闭预检进程，以同一ID启动原生agy --conversation。恢复须匹配返回的真实ID，不使用--continue选择最近会话，不维持额外后台服务。

## 实现与权限

| 位置 | 责任 |
|---|---|
| agent-bridge/lib/agents.js | 注册执行端、原生启动命令及结构化阻塞读取 |
| agent-bridge/lib/agy-client.js | 官方JSON事件解析、身份核验及元数据预检通道 |
| agent-bridge/lib/agy-hooks.js | 项目Hook合并、备份和无模型任务的会话预检 |
| agent-bridge/hooks/herdr-agy.js | 原生生命周期状态、会话关联和系统规则注入 |
| agent-bridge/skills/delegate-worker/references/agy-cli.md | 日常调用、审批、恢复和人工接管 |

项目.agents/hooks.json只增加本工程条目，保留其他Hook；原文件修改前备份到原状态根hook-backups。项目同目录生成codex-agent-bridge-agy.cjs，将本机检出路径绑定到正式Hook。绑定被人工修改时拒绝覆盖。两个文件属于本机配置，不应提交到业务仓库；全局登录、认证材料和权限设置不由适配器复制或重写。

Windows实测发现CLI的Hook参数解析会保留路径中的引号，直接使用带引号的绝对脚本路径会产生MODULE_NOT_FOUND。最终Hook命令使用不含空格的相对入口名，安装目录含空格的路径保存在JavaScript字符串中；回归覆盖含空格项目路径、配置保留和已修改绑定保护。

PreInvocation通过官方injectSteps/systemMessage注入稳定规则，同会话、同规则内容只注入一次；每轮规格继续给出当前目标、输入、允许修改范围、验收和交付。任务及会话分类仍由Codex/Skill根据上下文连续性判断，不增设固定角色枚举。

模型与effort可显式指定，未指定时继承CLI配置。本机真实测试使用gemini-3.8-flash-low和low，不将测试选择硬编码成全局默认。默认skipPermissions映射--dangerously-skip-permissions；保留审批可选--no-skip-permissions --permission-mode accept-edits。目录信任不等于工具永久授权，提示词和cwd均不是操作系统沙箱。

## 实际验证

| 项目 | 实际结果与范围 |
|---|---|
| CLI及身份 | 1.4.7，官方init返回真实conversation_id，重启进程后ID一致 |
| 文件任务 | normalizeLabel实现经固定测试独立验收；小写到大写的同会话追加要求通过 |
| 原生界面及恢复 | Herdr直接运行agy；关闭Pane、重建CLI后保持原ID和delta，未重复给出校验词，记忆产物的SHA256验收通过 |
| 原生返工 | 关闭原Pane后rework，原任务第2轮、同ID、新Pane、delta，固定验收通过 |
| Hook及规则 | 原生PreInvocation和Stop事件真实落盘，规则注入回执生成；程序回归核对systemMessage结构和同版本不重复注入 |
| 目录信任 | 原生首次信任提示导致Herdr blocked；读取具体目录后通过Herdr确认并恢复，无GUI操作 |
| 工具审批 | 受限权限任务分别要求创建一个授权外部测试文件、执行固定验收命令；各选择单次允许，保持同轮，最终独立验收通过 |
| 取消 | 原会话进入执行后发送Escape，Herdr返回idle，协调器cancelled；本项不包含运行中的外部后台命令撤销验证 |
| 启动阶段通知 | 修复watcher建立前阻塞未通知的问题，round=0持久状态及队列投递通过程序回归；新版队列的空闲自动开轮仍未重新实测 |
| 自动化 | 83项回归与8项原交付验收；CLI身份、错误及权限分支含夹具验证，不能替代真实账号耗尽或长时间断网实测 |

真实原始任务、ID、终端内容和报告只保存在本机.local/agy-check。公开证据只保留脱敏结论和可重复验收代码，见[evidence](../evidence/2026-10-28-agy/README.md)。

## 日常使用与限制

可自然语言要求：“把这项实现交给agy，由Codex检查文件和测试，通过后继续原计划。”Codex使用delegate-worker写任务书、选择相关worker-key，默认串行复用同一项目Workspace；显示名agy，同类实例以短编号区分。

首次目录已获授权时可传--trust-folder。未明确允许则保留blocked并通知；主控主动读取visible文本后处理，不能依赖用户盯窗口。具体审批优先在原生界面单次批准，使用Herdr的文本及按键接口即可，不依赖操作电脑、鼠标或浏览器。审批处理后resume恢复原轮观察；验收不通过时rework，通过后accept。

原生人工接管入口为agy --conversation <保存的workerSessionId>，需先核对原Pane和执行状态，禁止同时占用同一会话。网络、限流和配额问题保留任务与ID，不自动换模型或盲目重派；CLI可能自行重试，协调器不控制全部上游重试。消息入队与实际被Codex处理分开记录，不能保证配额墙期间即时验收。

整机重启、账号退出后的恢复、长时间无人值守、所有审批分支、所有模型组合、上下文自动压缩识别和外部后台命令中断未全面验证。接口升级后需重新验证；不以已有会话恢复测试扩大到上述场景。

## 官方依据

- [官方无头模式与JSON事件](https://www.antigravity.google/docs/cli/headless/)
- [官方会话恢复](https://antigravity.google/docs/cli/commands/resume)
- [官方项目Hook及规则注入](https://www.antigravity.google/docs/hooks/)

公开协议说明与本机1.4.7实测分别记录；未将文档中的可用接口直接当作实测成功。
