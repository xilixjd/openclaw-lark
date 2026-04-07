# AGENTS.md

本仓库是 fork。AI 或自动化代理在这里工作的默认目标：在满足需求的前提下，尽量减少与 upstream 的逻辑分叉，降低后续同步成本。

## 工作规则

1. 以上游为基线。优先复用、移植、对齐 upstream 已有实现，不要轻易另起一套。
2. 只做最小必要改动。优先局部补丁、兼容性补丁、外围适配；避免无关重构、批量改名、目录调整、格式化、依赖升级。
3. 非微小改动前先检查 upstream。若允许联网，执行：

```bash
git remote -v
git fetch upstream --prune
git remote show upstream
git log --oneline HEAD..upstream/<default-branch>
git diff --stat upstream/<default-branch>...HEAD
```

如果当前环境不能联网，至少检查本地已有的 `upstream/*` 引用，并在最终说明中注明未刷新最新 upstream 状态。

4. 尽量不要直接改上游核心链路。能通过配置、开关、包装层、适配层解决，就不要侵入主流程。
5. 如果必须偏离 upstream 行为，在最终说明中写清楚原因、影响范围，以及为何不能采用更贴近 upstream 的方案。
6. 发现工作区已有未提交改动时，不得擅自回滚、覆盖或顺带整理与当前任务无关的内容。
