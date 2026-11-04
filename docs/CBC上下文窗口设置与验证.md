# CBC上下文窗口设置与验证

## 本机验证结论

2026-11-02对CodeBuddy Code 2.179.2的国际版deepseek-v4.1-flash进行独立TUI测试。模型内置支持300000及1000000两档，默认300000。仅在用户settings.json添加contextWindow并由config get回读1000000，实际TUI及/context仍为300K；全局配置回读不能作为会话生效证据。

初始化seedContextWindow从CliSettingsProvider读取该字段，后者只构建CLI选项，未将全局SettingsManager中的同名值纳入。通过--settings传入contextWindow可以进入该初始化路径。此前已加入的无效全局字段已精确移除，autoCompactWindow及其他字段保持原样；不修改安装包、模型目录、账号、状态栏或权限。

## 已验证的启动方法

2026-11-03状态核对：三个cbc入口的参数注入均已失效，当前脚本不再包含--settings，check返回installed=false。入口修改时间为当日00:09:45，具体重建来源未核实。桥接目前仍依赖入口注入，未直接携带窗口预设，因此当前普通启动及桥接启动可能回到300K。此前安装时的1M实测结果属于历史证据，不代表入口持续有效；本次发布只纠正文档，未修改全局入口或当前业务窗口。

以下普通命令仅在check确认固定入口有效后采用：

```powershell
cbc
cbc --resume <原会话ID>
```

入口失效时使用以下已验证的显式参数方式，从本维护工程根目录执行：

```powershell
cbc --settings .\agent-bridge\examples\cbc-context-1m.json
```

该文件仅包含数值型contextWindow:1000000，不包含登录材料、模型选择、权限或Hook。文件参数可使用绝对路径，从其他项目启动时仍保留当前项目工作目录。恢复已有会话可同时使用CBC的--resume参数；不需要删除会话历史。

启动后执行/context，核对分母为1m；状态栏应显示1M window。该版本不会单凭全局同名字段自动采用1M。只有固定入口有效时，默认调用cbc.cmd的桥接后续启动才会间接载入；显式AGENT_BRIDGE_CBC指向其他程序时不保证使用该入口。当前已经运行的CBC进程不会热更新。

### 固定入口的安装与恢复

tools/configure-cbc-context.cjs仅为npm目录的cbc.ps1、cbc.cmd及无扩展名cbc补入默认--settings参数，保留原生程序路径、参数传递、工作目录和退出语义；不修改原生安装包、账号、模型目录、PowerShell profile、PATH或codebuddy命令。调用方显式提供--settings时，后面的参数由原生CLI处理，可覆盖该默认值。

```powershell
node tools/configure-cbc-context.cjs check
node tools/configure-cbc-context.cjs install
node tools/configure-cbc-context.cjs remove
```

备份及摘要清单位于.local/cbc-context-launcher。安装先校验全部入口再写入，可重复执行；卸载只恢复摘要与本工具安装结果一致的文件，不覆盖后续用户修改。npm升级可能重新生成这些入口，此时check会发现失配，install可以重新应用；保持本工程及预设路径可用，迁移前先移除旧绑定再安装新绑定。

本机安装后，Windows PowerShell 5.1普通cbc启动及CMD的cbc --resume恢复均通过实际TUI与/context确认1M。新增9项入口回归覆盖PowerShell 5.1和7的两种Windows入口、带空格参数、工作目录、退出码、重复安装、备份恢复、用户修改保护和npm重建。全量200项中199通过、1跳过，既有验收8/8；跳过仍为用户已取消并归档的Windows Tunnel客户端doctor。入口验证未发送模型请求，两个测试会话正常退出；原有codebuddy三个入口摘要未变。

## 实际验证证据

### Windows内联JSON及原生菜单补验

同日复测区分Shell传参行为：Windows PowerShell 5.1会将普通单引号字符串中的内部双引号在传给node.exe时剥离，CBC收到{contextWindow:1000000}，真实TUI仍300K。PowerShell 7.6.9的Windows传参模式保留双引号。此前直接提供通用内联写法未区分Shell版本，不能视为跨版本可用。

Windows PowerShell 5.1已实际启动验证的写法：

```powershell
cbc --settings '{\"contextWindow\":1000000}'
```

该写法真实TUI显示1M，/context为12.8k/1m。不要照搬到PowerShell 7：后者会保留反斜杠，导致非法JSON；PowerShell 7采用普通单引号JSON字符串即可。文件方式无需处理这些差异，继续作为稳定入口。

实际进入原生/config菜单完整偏好项及/model的Global、Session两页，均未找到上下文档位选择；已安装TUI配置键表不含contextWindow，模型面板为模型选择。官方ACP协议确有context_window/getConfigOptions选择能力，不能据此声称原生TUI已有同样菜单。本结论限本机2.179.2。

补验只执行本地命令与菜单浏览，未选择其他模型或修改菜单设置，模型请求数为0；测试进程均正常/exit。参数捕获、菜单及真实窗口摘要见私有verification-shell-menu.json。

| 项目 | 实际结果 |
|---|---|
| 全局字段配置后独立TUI | 300K window；/context为12.8k/300k |
| 通过--settings载入预设 | 1M window |
| 原生模型请求 | 正常返回CBC-CONTEXT-1M-OK，未调用工具，退出汇总0行代码变化 |
| 回复后/context | 16.5k/1m tokens；Autocompact buffer为80k |
| 测试退出 | 两个独立测试会话均使用/exit正常退出，未停止共享服务或用户会话 |

测试实际启动原生TUI并执行一次真实模型请求，没有向已有业务会话输入，也没有执行业务文件操作。首个测试只执行/context和/exit，模型用量为0；第二个测试执行短回复请求，退出汇总为13.3k输入、11输出、3.2k缓存读取。验证范围为真实客户端会话预算及短请求可用性，未进行接近百万token的满载请求，不能据此断言服务端满载稳定性。

测试采用已存在的用户登录态，未读取、复制或输出凭据。独立启动进程移除了Herdr/agent-bridge/Codex归属环境，避免测试消息归属业务任务；只信任本项独立空测试目录，未信任父目录。私有证据位于.local/cbc-context-20261102，包含原配置备份、隔离配置实验、真实TUI摘要及后续验证记录，不公开原生身份或完整设置。

## 维护边界

### 跨进程恢复不继承窗口覆写

同日对之前已用1M并完成真实短请求的同一个测试session做关闭后恢复：不带--settings时，状态栏恢复为300K，/context为16.5k/300k；再次退出并带同一预设恢复相同session，状态栏为1M，/context为16.5k/1m。历史与上下文仍保留，但窗口覆写不随会话历史跨进程恢复。两次补验无模型请求，均正常退出，证据见私有verification-resume.json。

没有固定启动入口时，新开终端、重启CBC或通过--resume恢复，都应再次传入--settings；不能依赖某次对话曾采用1M。该继承测试执行时未修改全局入口；后续已按用户要求将参数固定到cbc入口，当前使用方法见前述安装与恢复章节。

保留该预设可绕过当前初始化路径缺口，不修改上游程序。升级CBC后应以实际TUI和/context重新验证；如果后续版本修复全局设置读取，可再评估撤除启动参数。切换其他模型时必须核对其支持档位，不把1M强加给不支持该档位的模型。

## 2026-11-04桥接启动修复

Hark审核整改同时将CBC descriptor的buildCommand改为显式传入本工程examples/cbc-context-1m.json，不再依赖全局cbc入口是否被npm重建。普通新启动和原session恢复均经过该构造；Herdr恢复包装器也复用同一descriptor，保留任务指定settings/model/effort/权限/策略。命令构造和包装器隔离回归通过，本轮未重启真实CBC或再次执行模型请求；此前2.179.2真实1M短请求证据保持原范围。用户在普通终端直接输入cbc仍受全局入口实际状态影响，此修复不修改全局入口。
