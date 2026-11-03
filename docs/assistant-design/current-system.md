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

## 与协作助手方案有关的兼容边界

2026-11-03 回拉静态实现与上游面板文档后确认：

- [005 Panel](../005-panel.md) 与 [ExecutionStatus](../../src/client/execution.tsx) 已有并行 Ticket 列表、筛选、负载和暂停入口；[overview.ts](../../src/app/views/overview.ts) 汇总待人工事项，不能直接认定缺少全新的状态面板。
- [ticket.tsx](../../src/client/ticket.tsx) 已提供执行会话入口、输入和订阅详情、人工问题及返回外部渠道回答的入口；[app.tsx](../../src/client/app.tsx) 提供打开原主 Session 的入口。
- 核心 [Ticket](../../src/core/model.ts) 是授权工作单元，与 RouteLedger 阶段责任不同。设计已明确不新增 Feature 实体，用户的需求语义不要求一层对应模型。
- [intake.ts](../../src/core/intake.ts) 按 Thread 订阅向工单扇出消息。若把整个助手长期对话当成普通可订阅 Thread，后续无关讨论可能进入此前订阅的工单；这是直接复用该语义时的兼容风险，不是对已实现助手的运行缺陷报告。

以上为兼容核对，未修改代码，也未运行插件。目标与责任选择在 [design-focus.md](design-focus.md)，剩余问题见 [interaction-proposals.md](interaction-proposals.md)。

### 现有对象与接口的充分性

后续静态核对支持“现有对象可承载主要使用需求，协作操作入口仍需适配”：

| 能力 | 已有支撑与限制 |
| --- | --- |
| 查询状态与详情 | [api.ts](../../src/app/api.ts) 提供 overview/tickets 等查询；[resources.ts](../../src/app/resources.ts) 提供报告、输入、执行 transcript 及逐消息分页读取，存在角色和访问范围限制 |
| 新工作进入执行 | [main.ts](../../src/app/tools/main.ts) 的 orchestrator_route 依赖已记录的 trigger_id；[Engine.decide](../../src/core/engine.ts) 沿既有准入、决定、工单链路执行，不是任意助手文本直接建单 |
| 定向追加要求或答复 | [Engine.attach](../../src/core/engine.ts) 复用 Trigger 并订阅其 Thread；不能直接当作“仅交接本次选定内容”的通用入口 |
| 提供背景事实 | orchestrator_ticket_note 只提供事实，不授予新工作权限，不能替代用户要求的追加 |
| 停止与重试 | Engine 命令、管理 API 和部分主会话工具已有支撑，继续遵守对象状态及权限限制 |

因此后续重点是新工作来源和定向输入的接口适配、原始依据与授权的表达；不绕过既有校验，也不新增 Feature 状态。已有执行 transcript 读取不等于已具备新协作助手全部历史的搜索接口；仍需核验可复用范围。

## 本地接续环境

- 工作分支为 `dev`，跟踪 `origin/dev`。`main` 用于上游同步，`master` 为个人集成分支。
- 前序操作已回读验证 GitHub：`main` 只读并允许 fork 同步；`master` 要求 PR 合入；二者管理员同受限、禁止强推和删除。远端设置属于可变外部状态，后续操作前按需核验。
- 已按用户要求初始化 CodeGraph；[codegraph.json](../../codegraph.json) 排除第三方依赖、构建产物、覆盖率目录与锁文件，未删除依赖。索引是本地派生产物，后续按当前磁盘状态同步。
- 后续定位代码优先使用 CodeGraph。本轮未安装项目依赖、运行业务测试或构建，不据此声称插件行为已通过运行验证。
