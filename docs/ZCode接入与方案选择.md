# ZCode接入与方案选择

## 结论与适用版本

采用路线A：通过官方Remote Relay V2连接运行中的Desktop Host，由原生Node适配器发送V4文本命令、订阅权威快照并恢复原会话。日常派工无需浏览器技能，不改ZCode安装包，不要求单独配置API key。已在Desktop 3.16.3、内置Agent CLI 0.17.0、Node.js 24.14.0验证Start Plan的GLM-5.3-Flash/low。真实交付仍由Codex独立验收。

该路线复用官方内部客户端与服务协议，属于可维护的源码适配，尚不属于官方承诺稳定的第三方远控SDK。协议代码固定在上游提交`3c5b227649371507ddc4eb46ac5133afe6db1cab`，升级Desktop后需重新验证。真实响应使用account:zai-start-plan Provider，证明当前Desktop账户通路可用；具体套餐计费规则仍由平台决定。

## 三条路线比较

| 路线 | 实测结果 | 限制与维护成本 | 选择 |
|---|---|---|---|
| A：运行中的Desktop Host | 原生Relay配对、RPC、Start Plan Flash回复、文件任务、同会话返工、Pane恢复、差量上下文与stop通过 | Desktop须运行、登录并启用远控；席位可能被手机/网页抢占；内部接口升级需复验 | 当前默认 |
| B：独立app-server | stdio协议、会话创建/恢复、订阅、命令去重可用；显式Start Plan模型执行报modelUnavailable | 无Desktop Host下发的Account Provider Registry与完整模型配置；需要额外构建认证与Provider同步 | 独立API/Provider需求出现时再评估 |
| C：独立CLI -p | 入口可执行；补Provider文件路径后仍提示先选模型 | 当前打包路径不一致；独立账户初始化只覆盖individual-coding-plan，不能据此承诺Start Plan；没有已验证的无头模型选择流程 | 保留调查，不继续反复修补 |

Desktop登录后B/C仍未自动获得所需配置，因此此前失败不能归因于“没有打开或登录App”。ZCode自身提供的CLI建议描述了通用能力，未证明这台机器的Start Plan无头链路成立。官方实现将Host设为Provider Registry源，CLI设为会话执行事实源，解释了两种运行拓扑的差异。[官方协议说明](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/zcode-protocol.md)

## 实现边界

链路为`Codex → agent-bridge → Herdr zcode Pane → Node Relay/RPC适配器 → Desktop Host → 原有CLI runtime`。不启动另一套独立模型服务，不通过网页输入框派工。首次按业务目录查找Desktop项目；不存在时调用Project服务创建项目条目。新建任务会话与已有用户聊天分离，返工保留真实sessionId。

Relay采用官方一次性terminal token、配对、心跳及二进制Channel RPC；物理分片、校验、ACK与conversation归约采用固定版本官方代码。共享登录读取采用官方只读函数与cipher，解密值只驻留内存，仅向固定官方域名发送；HTTP重定向被拒绝。链接和SID/MID属于本机绑定信息，禁止公开。[官方Relay实现说明](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/relay-v2-pairing.md)

V4命令先落盘再发出，保存commandId、sessionId和ACK。ACK accepted只表示命令被接收；只有当前sourceCommandId对应的turnHeader终态才能收口，不能把用户文本或旧轮次成功当成本轮完成。重连只读原快照、观察原命令，不盲目重发；KICKED停止连接，不争抢席位。执行结束和阻塞后释放Relay连接，Desktop会话继续保留。

上下文回执记录项目、实际会话、Pane/terminal、规则版本与哈希。只有交付后才视为建立基线。后续同一会话按差量发要求，范围和验收每轮保留；CBC压缩Hook触发完整模式。ZCode重连时若看到成功压缩标记或历史窗口不完整，适配器将当轮提升为完整模式；--full-context可由主控显式要求重发基线。原Pane关闭后的同任务恢复保留会话，但保守重发完整背景；跨任务自动复用目前仅限仍存活并通过身份核对的worker。

## 本机绑定与日常使用

Desktop保持登录并开启官方Web远控。私有连接配置内容如下，链接使用Desktop生成的真实值，不能入库：

```json
{
  "remoteUrl": "<官方远控链接>"
}
```

默认文件位置为`%LOCALAPPDATA%/agent-bridge/zcode-desktop.json`；指定其他状态根时默认随状态根变化。--zcode-config或AGENT_BRIDGE_ZCODE_CONFIG可显式绑定私有文件。配置仅保存连接信息，不保存解密后的登录凭据。Desktop重新生成链接后更新此文件。

日常在Herdr的项目Workspace中恢复Codex，然后使用自然语言：

> 使用delegate-worker把这个边界明确的任务交给zcode，使用Flash；先核对已有会话，交付后由你检查改动并运行固定验收。

Codex编写完整task-spec-v1，使用--agent zcode派工。缺少必要规格会在启动前失败。需要重开会话时--new-session；正式要求变更时rework附更新的--spec-file。默认GLM-5.3-Flash/low，不自动切到GLM-5.3或其他模型。GLM-5.3系统繁忙与余额不足是不同问题，均如实保留状态处理。

与CBC默认-y一致，ZCode默认跳过权限检查映射yolo；--no-skip-permissions --permission-mode edit保留工具批准，Bash测试命令可能暂停。cwd、允许文件列表及强规则提示不是OS沙箱。CBC原生追加系统提示词，ZCode注入V4用户文本，不宣称具有相同的系统指令优先级。

## 接管、恢复及限制

- 使用zcode-control snapshot查看当前权威状态；只有请求内容在已有授权内时，显式approve-once当前interactionId，再resume。不会自动批准所有工具，也不授予项目级或完全访问权限。
- 普通resume重新观察原会话/命令，关闭执行Pane后也可恢复；resume --force属于明确重投，必须先确认可以重复执行。
- cancel发送stop并等待无activeWorks，未确认时保持cancel_pending。只关闭Herdr适配Pane并不等于停止Desktop中的模型执行。
- 断网、登录过期、配额墙、模型繁忙、Desktop退出或远控关闭均保留任务与会话。模型侧可能存在自身重试，协调器不保证关闭全部内部重试。
- 手机或网页同时连接可能触发KICKED；结束其他远控连接后再恢复，不能循环争抢。日常无需打开浏览器。
- 整机重启、长时间无人值守、全部权限分支、真实额度耗尽与所有Desktop升级组合尚未全面验证。新版Codex队列空闲自动唤醒仍待独立补验，队列成功不等于主控已经验收。

## 维护入口

`lib/zcode-remote.js`负责连接、RPC、快照及当前命令终态；`bin/zcode-worker.js`负责Herdr承载、命令日志、报告与恢复；`bin/zcode-control.js`负责显式单次接管。业务轮次、通知、验收、任务位置和Skill仍复用公共实现。固定协议子集位于vendor/zcode，源码清单、摘要、许可证与重建方法随目录提供。

接入其他Agent仍按统一适配契约提供启动、状态、追加要求、结果、取消和会话恢复；无需复制ZCode专用协议，也不改Codex的验收权。
