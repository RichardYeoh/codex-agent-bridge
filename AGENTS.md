# Codex Agent Bridge 工作约定

## 项目定位与接续

Codex是唯一主控，负责规划、核心决策、派工、审查、验收与后续推进。Herdr负责运行承载和终端状态；CBC是首个执行Agent。后续持续接入其他Agent，业务编排须保持与具体执行端解耦。

开始维护先读取根目录README.md和协作环境进度台账.md顶部，按需读取Codex审核报告.md、项目会话记录.md及agent-bridge/docs/adapter-contract.md。历史记录不等于当前待办。未知事项必须标明，不能用旧版本结果替代新代码验证。

## 目录与变更归属

- agent-bridge/bin：业务命令、监听进程。
- agent-bridge/lib：执行端描述、位置、身份、状态与通知。
- agent-bridge/hooks、scripts：事件集成、安装与卸载。
- agent-bridge/skills/delegate-worker：经审核技能的唯一源版本；安装副本由安装器生成。
- evidence：可公开的测试工程、结果和调查证据；原始记录的脱敏副本须注明处理范围。
- tools：显式运行的实验和验证工具，默认输出写到.local。
- .local：本机状态、完整历史归档、凭据相关配置备份及迁移证据，禁止入库。

只修改本任务相关内容，保留其他项目与用户改动。禁止整目录覆盖用户配置、提交凭据或复制受保护认证材料。脚本和文档使用UTF-8；新增代码注释中英双语。路径通过检出位置、环境变量或安装绑定获得，不提交维护者的本机绝对路径。

## 编排约束与扩展

默认单任务委派，一个项目复用一个Workspace，执行者在同Workspace的Pane/Tab运行。独立项目、Git Worktree或明确隔离时才新建Workspace。显示名使用Agent名称，例如cbc；任务ID和会话ID独立保存。

派工须明确任务范围、可改文件及固定验收命令。完成仅进入review_pending；Codex独立验收，通过后accept，不通过rework原会话。身份需核对Herdr服务、Pane、terminal、Agent类型与执行会话；不凭UI焦点或面板名推断。

不确定提交不自动重发；连接错误不等于执行结束。断网、限流、配额和超时保留会话与状态，不自动换模型或无限重派。通知按状态根和Codex线程合并，区分queued和acknowledged，清理仅限本协调器消息。已进入执行的消息无法撤回。

接入其他Agent先按适配契约验证启动、状态、追加要求、结果、取消与会话恢复，再注册执行描述。通知、轮次和验收仍归协调器。ZCode已注册Desktop Relay/RPC执行端，默认GLM-5.3-Flash/low，复用Start Plan；依赖Desktop登录与远控开启，不依赖日常浏览器操作。上游协议来自官方内部实现，固定源码与版本，升级须复验。配置链接与登录材料不得入库。

派工提示词编写方法归delegate-worker；协调器强制task-spec-v1并注入规则、保存上下文回执和full/delta选择。新dispatch须--spec-file；返工改变正式要求时同时更新规格。sessions只提供历史与候选，不替代实时身份核对。CBC有原生系统提示追加接口，ZCode为V4用户文本注入，不将二者声称为相同强度的系统约束。只在已交付的真实会话中复用上下文，未确认执行不得直接省略背景。

## 安装与验证

```powershell
npm ci
npm test
npm run test:e2e
npm run install:skills
```

仅在需要安装CBC Hook时运行npm run install:integration；修改配置须保留无关项并备份。技能源中的{{AGENT_BRIDGE_ROOT}}由安装器替换，不能只修改用户目录下副本。

涉及派工、通知、Hook或恢复的行为变更须补相关回归；组件升级须做独立工程的真实链路验证。当前新版通知空闲唤醒仍待真实补验，不得宣称全面无人值守稳定。维护中不停止主控Codex或Herdr常驻服务。

## 记录与发布

实施结果写入项目会话记录.md，当前待办与版本写入协作环境进度台账.md，使用方式同步README。全局记忆依用户授权单独处理，不将项目技术日志铺到全局。

提交前检查差异、测试结果、公开文件中的凭据/身份/绝对路径，以及.local未被跟踪。使用简洁的带范围提交信息。发布到GitHub须有用户授权，不默认修改仓库可见性或添加开源许可证。
