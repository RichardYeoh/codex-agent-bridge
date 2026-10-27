# 任务：验证同一项目 Workspace 内的执行位置

保持当前项目内容不变，只允许新增 `layout-proof.txt` 和协调器指定的交付报告。写入一行 `cbb|workspace-reuse|ok`，执行 `node -e "const fs=require('node:fs');if(fs.readFileSync('layout-proof.txt','utf8').trim()!=='cbb|workspace-reuse|ok')process.exit(1)"`，期望退出码0；再执行 `node --test acceptance.test.cjs`，期望7通过0失败。

交付报告记录本轮验证命令的真实输出。不要修改其他文件，完成后保持会话等待主控验收。
