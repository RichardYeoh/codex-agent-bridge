# 0.3.1上下文与布局验证

自动回归72/72、原交付验收8/8通过。新增验证覆盖不透明工作上下文绑定、旧台账兼容、关闭Pane后的原生会话恢复计划、连接错误不另建会话、未闭合任务占用保护、明确5路并行的绑定/写入范围约束，以及Codex左半屏保留。

`layout-summary.json`为真实Herdr空终端验证：在隔离Workspace从1到10个执行Pane逐步分配，主Pane始终保持完整高度及左半宽度；第1页最多两个执行Pane，后续每页最多四个。10个几何检查全部通过，没有调用模型；验证Workspace由本次创建，终端身份核实后已关闭，未操作用户其他Workspace。

`session-summary.json`为真实跨任务恢复：CBC与ZCode旧Pane均已关闭，新任务自动恢复各自先前保存的原生sessionId，而非建立空白会话。两者均以delta派工，在没有重复提供测试字符串的条件下凭原会话记忆生成新文件，主控分别运行CBC_RESTORE_PASS与ZCODE_COLD_PASS验收并accept。实测主Workspace两个执行Pane同时存在时，Codex为82/164列并保持45/45行，执行者仅位于右侧上下。

会话选择原则在Skill，由Codex判断连续工作上下文，不采用固定角色或任务类型枚举。CLI只保存不透明worker-key与真实sessionId。5路并行调度限制仅经自动回归验证，未为此实际启动5个模型；同一ZCode Desktop Relay仍为单terminal席位。

私有会话标识、原始提示、任务状态、几何服务ID和模型交付保留在.local，公开摘要仅保留布尔结果、计数与几何尺寸。前版未验证项仍保留：新版Codex队列空闲唤醒、整机重启、长期无人值守、全部权限分支及真实配额耗尽。
