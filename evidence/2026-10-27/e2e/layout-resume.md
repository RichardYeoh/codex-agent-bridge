# 追加任务：恢复同一执行会话

上一轮校验已由主控独立通过。现进行经用户授权的异常恢复实验：原执行 Pane 已关闭，协调器应恢复同一个 CBC session，并继续使用同一个项目 Workspace。

只允许将 `layout-proof.txt` 改为一行 `cbc|workspace-reuse|resumed`，以及写本轮交付报告。执行 `node -e "const fs=require('node:fs');if(fs.readFileSync('layout-proof.txt','utf8').trim()!=='cbc|workspace-reuse|resumed')process.exit(1)"`，期望退出码0；再运行 `node --test acceptance.test.cjs`，期望7通过0失败。

请在报告中从已恢复的会话记忆写出上一轮证明文件原来的完整内容，不读取旧交付报告或任务文件来寻找它。注明当前目录和本轮真实命令输出，不修改其他文件。
