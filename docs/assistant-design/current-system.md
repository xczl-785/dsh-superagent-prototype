# 现有工程依据与目标差距

本文件是对当前原型的有限静态梳理，不是全面审计，也没有启动插件验证。检查基线为本次 fork 的初始提交 `6337fc823ce20251c8de8085948165c81aaa701e`；源码发生变化后应重新核对相关结论。

完整模块索引沿用上游 [007 Architecture](../007-architecture.md)，此处只保留支撑个人助手探索的事实。

## 工程定位与主要责任

这是 DSH 上的 superagent bundle，不是 DSH 本体。DSH 提供会话、模型、工具、工作区和客户端框架；本仓库负责来源监听、准入判断、工单调度、执行适配与管理面板。

| 位置 | 与本次设计有关的责任 |
| --- | --- |
| [src/index.ts](../../src/index.ts) | 后端插件入口 |
| [src/app/runtime.ts](../../src/app/runtime.ts) | 组装依赖与生命周期 |
| [src/core/engine.ts](../../src/core/engine.ts)、[ports.ts](../../src/core/ports.ts) | 领域命令及评估、执行、回复接口 |
| [src/sources/](../../src/sources/) | GitHub/飞书事件读取、转换和回复 |
| [src/executor/dsh.ts](../../src/executor/dsh.ts) | 工单执行会话与工作目录 |
| [src/app/sessions.ts](../../src/app/sessions.ts) | 会话创建、恢复、输入投递、角色工具 |
| [src/client/index.tsx](../../src/client/index.tsx) | 面板与 DSH 界面接入 |
| [src/app/store.ts](../../src/app/store.ts) | SQLite 领域状态与相关记录 |
| [prompts/](../../prompts/)、[cordis.patch.yml](../../cordis.patch.yml) | 角色行为与工具预设 |

## 消息、工单与执行会话如何关联

基本路径为 `外部消息 → Trigger → Thread → 订阅工单 → worker 会话`。

- Source 确定消息所属 Thread。工单创建时订阅相关 Thread；GitHub Issue/PR 使用 `github:<编号>` 标识。
- Thread 与 Ticket 多对多。后续消息根据订阅扇出，可能进入多个工单；同一工单的输入会去重。
- 仅参考上下文的订阅有区别，不同于承担该消息的工单关系。
- 没有工单负责的消息进入评估/路由；主会话可接受新工单或关联已有工单。
- 新消息关联旧工单时，提示词要求明确指向，不能只因主题相似就关联整个 Thread。
- 执行会话 ID 为 `worker-<ticketId>`，以工单为归属恢复；一项工单可以先后有多个 Assignment，执行器还可使用子 agent。
- 人工后续消息在满足条件时可恢复已结束工单；人工停止和仅参考上下文等情况有不同规则，不能概括为所有消息都自动重开。

依据：[intake.ts](../../src/core/intake.ts)、[tickets.ts](../../src/core/tickets.ts)、[dispatch.md](../../prompts/dispatch.md)、[dsh.ts](../../src/executor/dsh.ts)、[sessions.ts](../../src/app/sessions.ts)。

## PR 与结果交接

执行器按提示词使用 Git/GitHub CLI 实施、验证、提交、推送并创建 PR。创建后通过报告携带 `pr_number` 绑定；宿主核对作者、仓库和工单分支归属，也可以通过唯一匹配恢复缺失关联。一个 PR 不能绑定给多个活跃工单。

PR 反馈到绑定工单，报告中的具体人工问题与结果通过主会话转达。普通进展通常留在内部。`ready` 报告、工单结束和 PR 合并是不同状态，不能等同。

依据：[work.md](../../prompts/work.md)、[worker.md](../../prompts/worker.md)、[github-pull.ts](../../src/sources/github-pull.ts)、[executor tools](../../src/app/tools/executor.ts)、[notices.ts](../../src/app/notices.ts)。

## 为什么现有主会话不能直接等同于协作助手

用户可以在插件界面打开主会话，最初以为它承担需求沟通角色。当前提示词却主要让它准入、路由、派工和转达，要求不要替执行器展开实施计划、验收标准或技术设计；执行器根据原始请求做具体工作。

这支持“当前偏执行闭环”的判断，但不表示模型完全不能分析或讨论。明确的分析任务可以交给执行器，执行中也有提问机制；缺少的是产品上明确、持续负责探索与需求形成的协作过程。

依据：[orchestrator.md](../../prompts/orchestrator.md)、[dispatch.md](../../prompts/dispatch.md)、[worker.md](../../prompts/worker.md)、[work.md](../../prompts/work.md)。

原有 worker 绑定已接受的 Ticket、Assignment、范围和交付报告。复用 DSH 会话能力与直接复用 worker 业务语义是不同选择；“权限受限 worker 是否足够”仍未决定。

## 本地接续环境

- 工作分支为 `dev`，跟踪 `origin/dev`。`main` 用于上游同步，`master` 为个人集成分支。
- 前序操作已回读验证 GitHub：`main` 只读并允许 fork 同步；`master` 要求 PR 合入；二者管理员同受限、禁止强推和删除。远端设置属于可变外部状态，后续操作前按需核验。
- 已按用户要求初始化 CodeGraph；[codegraph.json](../../codegraph.json) 排除第三方依赖、构建产物、覆盖率目录与锁文件，未删除依赖。索引是本地派生产物，后续按当前磁盘状态同步。
- 后续定位代码优先使用 CodeGraph。本轮未安装项目依赖、运行业务测试或构建，不据此声称插件行为已通过运行验证。
