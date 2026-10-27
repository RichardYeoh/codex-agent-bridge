# 执行 Agent 适配契约

## 当前边界

对主控公开的任务命令与执行 Agent 分离：`dispatch` 启动任务，`status` 读取持久状态，`rework` 追加下一轮要求，`read` 加交付文件获取结果，`cancel` 请求中断，`resume` 恢复执行会话。验收逻辑使用任务ID、轮次和交付证据，不使用 Agent 显示名定位文件。

当前运行承载为 `herdr-pane`。注册表不等于完整适配器，新增名称本身不能接入一个 RPC 服务。执行端须提供下列可验证行为：

| 行为 | 契约 |
|---|---|
| 启动 | `buildCommand(task, resumeId)` 返回 PowerShell 可执行命令；收到恢复ID时复用对应执行会话 |
| 位置 | 使用协调器创建的项目 Workspace 内 Pane/Tab，显式隔离才新建 Workspace |
| 身份 | 上报真实 Agent 类型、session ID；由协调器保存 Herdr session、Pane ID、terminal ID和独立 Agent 名 |
| 下发 | 接受一次任务文件指针；承载为原生 Herdr Agent 时可用原生 prompt，CBC 使用显式 Pane 输入 |
| 状态 | 上报 working、idle、blocked；交付仅进入 review_pending，最终 accepted 由 Codex 决定 |
| 会话记录 | hook事件必须携带 taskId、herdrSession、paneId、sessionId和时间；跨服务同名Pane不能混用 |
| 结果 | 每轮单独写交付报告；报告存在不代表内容通过验收 |
| 取消 | 支持中断请求；未观察到停止时返回 cancel_pending，禁止宣称已经停止 |
| 恢复 | 不确定提交不自动重发；恢复同一会话后重新记录新Pane和terminal身份 |
| 资源阻塞 | 网络、限流、配额耗尽需可观察；保留会话、轮次和原因，原执行未停止时不得自动重派；执行端内部重试须由该适配器明确说明 |

`lib/agents.js` 保存 Agent 元数据、显示名、Herdr识别类型、启动命令、提交方式和能力说明。`lib/location.js` 统一位置策略；`lib/worker.js` 统一身份与会话事件关联。业务状态、轮次、通知和验收继续由协调器管理。

通知由 `lib/notification-control.js` 统一合并及撤回，执行适配器不直接向Codex投递。`lib/codex-client.js` 负责原生队列传输；`lib/blocker.js` 提供CBC终端错误的辅助分类，后续Agent可将协议化错误映射到相同blocked语义，不要求复用终端正则。

## ZCode 的当前实现

当前zcode-worker作为Herdr中的Node交互程序，接收单行任务文件路径，通过Desktop Remote Relay/Host RPC发送V4命令、订阅当前会话并上报自定义zcode身份。Escape转为V4 stop，完成后释放远控连接。直接app-server与独立CLI保留为备选，当前不管理它们的独立认证与Provider。

适配器使用官方只读共享登录函数，仅在内存取得Relay认证，固定官方域名，连接配置私有保存。命令日志和sourceCommandId控制收口，普通resume按原会话和命令恢复观察，replayOnRelaunch=false防止Pane重建触发自动重投。新适配器可声明resumeInput、readBlocker及readPromptContext，分别恢复观测、读取结构化阻塞和回报实际提示模式；公共协调器继续管理任务状态与验收。

worker-policy统一规格校验与提示渲染；worker-context维护真实会话的已交付回执；worker-lease解决同一执行进程先后承担不同任务时环境变量仍保留旧taskId的问题。注册名称不是集成完成的证据，新执行端仍须实测所有必要行为。具体ZCode路线与限制见[接入说明](../../docs/ZCode接入与方案选择.md)。

0.3.1使用不透明worker-key保存多个工作上下文，分类与选择由Codex/Skill负责；worker-binding仅核对绑定，worker-scheduling保持默认串行并校验明确并行的写入范围。已关闭Pane的跨任务恢复将保存的原生sessionId传入buildCommand；启动后须有真实session回执才能继续使用差量。location固定保留Codex左半屏，后续按每页4个执行Pane分配，不按任务调用次数增加位置。

Source server 的远程连接与手机远控是不同入口，不能因为存在同名 V4 命令，就把远端 server 的 `/ws` 接口当成现有桌面的本地监听服务。
