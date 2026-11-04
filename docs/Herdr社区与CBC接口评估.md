# Herdr 社区与 CBC 接口评估

日期：2026-11-04。目标：评估已有实现能否代替当前 CBC 生命周期桥，避免重复维护。

## 结论

已找到官方社区和数个相关开源项目，但尚无已验证可直接替代的方案，同时满足 Windows 原生、可见 CBC TUI、沿用账号与原生会话、逐轮返工、可靠交付通知及 Codex 独立验收。此次保留现有架构，借鉴已有实现的事件游标、回执分级、持久登记和失联后对账方式；未安装候选软件或迁移状态。

## 社区入口与候选

| 来源 | 可复用价值 | 与当前要求的差距 |
|---|---|---|
| [Herdr 官方 Discussions](https://github.com/herdrdev/herdr/discussions)、[委派讨论 #741](https://github.com/herdrdev/herdr/discussions/741) | 跟踪官方协议与其他使用者的委派实践 | 低层通信能力不能直接等同于业务任务交付协议 |
| [Namedrop](https://github.com/ericbust/namedrop) | 跨 Pane 协作、部分结果回流、结果新鲜度 | README 列出 macOS/Linux 与 Codex/Claude；不能据此确认 Windows CBC 支持 |
| [herdr-control](https://github.com/tntpgh/herdr-control) | 持久任务登记、事件序号及通知补偿 | Bash/Python 编排；没有已验证的当前 CBC 原生会话适配 |
| [Herdr Group Chat](https://github.com/terry-li-hm/herdr-group-chat) | 回合记录、review/retry、人工收口 | Preview，未证明 Windows CBC 契合；停止收集不等于终止原生执行 |
| [AionUI](https://github.com/iOfficeAI/AionUi) | Windows 图形界面和 CodeBuddy ACP 集成 | 管理自身 ACP 对话，未证明能接管当前 Herdr Pane 的 CBC TUI 原会话 |
| [VS Code Herdr Bridge](https://github.com/alwaysmissin/vscode-herdr-bridge) | 编辑器上下文转送 | 用途是上下文粘贴，不能替代任务接纳与完成确认 |
| [Herdr Core](https://herdr.dev/core/) | 持久终端进程及 attach/send/wait | 属于另一运行层；不能把其能力视为已安装 Herdr 0.9.5 的接口，也不替代 CBC 回合证明 |

采用任何候选前仍须核对许可证、目标版本、Windows 兼容性和故障恢复；本次未复制第三方源码。

## CBC 官方方案

[Remote Control `/gateway`](https://www.codebuddy.cn/docs/cli/remote-control)描述了交互终端与远程界面的同步能力，但默认尝试 Tunnel，远程任务使用 `bypassPermissions`。公开文档未给出明确的强制仅本机参数。现有网络与审批边界下不直接启用。

[HTTP API](https://www.codebuddy.cn/docs/cli/http-api)提供 run ID、查询、SSE 与取消接口。文档中的调用方消息 ID 未完整规定重复请求的行为；也未充分说明 `/runs` 如何绑定已存在的交互 TUI 会话。因此“有 API”还不足以认定可无缝替代当前投递路径。

[stream-json](https://www.codebuddy.cn/docs/cli/headless)更适合结构化自动编排，但采用无头交互形态。若以后允许替换可见 TUI，可优先单独验证这一官方路径；不应同时让 TUI 与无头进程未经排他控制地写同一会话。

本机只读确认已安装 CBC 2.179.3，源码含 Gateway 实现；没有启动 Gateway、建立公网隧道或改变权限。上述接口语义为公开资料调查，不能称为本机端到端通过。

## 已确认的 Herdr 契约

Herdr 0.9.5 的 [session_ref_from_report](https://github.com/herdrdev/herdr/blob/v0.9.5/src/agent_resume.rs)仅为官方认可的来源生成原生会话引用，来源列表不含 CodeBuddy/custom。因此 CBC 回包缺少 `agent_session` 属于预期行为，不能靠添加 `--agent-session-id` 假定字段必然出现。

当前桥接以真实 Hook、原生历史、Pane 租约和进程证明建立对应关系。缺少足够证据时保留不确定状态；不冒充官方来源，不按窗口标题猜测身份。
