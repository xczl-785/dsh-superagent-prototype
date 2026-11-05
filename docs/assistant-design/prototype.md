# 项目助手原型：实现、使用与验收边界

本文件维护首个实施增量的实际机制和验证范围。目标、能力与职责仍以 [design-focus.md](design-focus.md) 为准，个人偏好记忆要求仍由 [assistant-memory.md](assistant-memory.md) 维护。

## 已接受的实施范围

2026-11-05 用户接受：真实工程讨论、创建工单、定向追加或答复、反馈接续和中断恢复；个人偏好记忆留到下一增量。首次实施交付可安装版本，未代为安装到现有 Harness。随后用户在桌面端安装插件，客户端已恢复并按要求补入目录配置；当前缺少 GitHub 配置，助手实际对话与执行闭环仍未试用。

用户已验证 DSH SS 机制正常，允许把该边界作为可信契约模拟测试；没有 GitHub 仓库及账号用于联调。禁止桌面接管和影响电脑操作的测试，使用临时目录、模拟宿主及无头 DOM 组件测试。模拟只存在于 tests；生产代码调用真实 Harness、SQLite、Engine、效果队列和既有执行器。

## 运行与使用

沿用仓库现有部署前提：配置真实 GitHub 仓库、代理账号及可用模型，完成原有 setup 后，Runtime 创建并恢复一个 `assistant-<stateDir hash>` 会话，与原主 Session 分离。助手使用 Harness 的 `standard` 预设、研判角色模型配置，并加载 [assistant.md](../../prompts/assistant.md)。

在插件配置中设置 `assistantWorkspace` 为本地项目检出的绝对路径；为空时使用 stateDir，助手必须另行取得仓库依据，不能把状态目录当作项目源码。此项为非 volatile 配置，修改会重载插件；已有 DSH 会话的工作区不会因此自动迁移。首次启用前配置正确路径，迁移已有助手工作区需另行处理。

管理面板顶部“项目助手”打开真实 DSH 会话；工单详情“与助手讨论”先通过管理 API 投递工作引用，再打开同一个助手。引用只提供讨论对象，不授予修改该工作的权限。

顶部“高级”中的“显示后台调度会话”默认关闭，设置保存在 SQLite；开启后显示原后台调度会话入口。不暂停或停止后台处理。当前只控制插件面板入口，未实现 DSH 全局会话列表隐藏。

当前仍需要原系统的 GitHub setup；这不是一个脱离 GitHub 配置运行的本地执行模式。缺少账号时不能据此声称真实部署已通过。GitHub/飞书的原有渠道处理继续走原链路。

A01 已修正首次安装与状态表达：未提供 stateDir 时根据 Harness 配置服务的 profile patch 路径选择同 profile 下的 `state/dsh-superagent`，显式目录优先；无 profile 元数据时仍要求显式配置。状态接口区分初始化中、待配置、可用与失败，只有初始化成功才提供助手入口 ID。启动失败保留管理页面和失败事实。缺 GitHub 不创建助手会话，也不接受工作引用操作。49 项相关检查、类型检查与构建通过；桌面真实配置完成后的行为仍待试用。

后续独立需求与批次进展由 [任务板](task-board.md) 和 [渐进式计划](next-batch-plan.md) 维护。继续保留 GitHub 使用前提，不增加独立启动能力。

## 交接与反馈契约

- 只有来自该助手会话、由 Harness 标为 `source.kind=user` 的消息可作为原始用户依据。插件反馈不能冒充用户。固定本地身份为 `assistant/local-user`，表示本机 DSH 使用者，不映射外部账号；自然语言授权的范围仍需助手判断。
- `assistant_create_work` 引用原消息 id；原文保持在 Trigger，助手整理的范围与背景分别进入 Mandate 和执行交接内容。每次操作使用稳定的 request_id；同一消息与 request_id 的重试复用结果，内容改变则拒绝。
- 每个选定操作使用独立 Thread，不把长期对话订阅给 worker。建单、来源关联及反馈关联在同一 SQLite 事务内完成。Engine 继续负责准入与执行状态；没有第二份工单状态机。
- 创建返回 `created` 和工单标识，派工仍为 pending；`assignment_dispatched` 只表示执行器已向 worker 会话投递任务，不能表述为模型已经开始思考。
- `assistant_update_work` 定向交接本次用户要求；答复时可携带当前 question_id，过时问题会被拒绝。返回成功表示输入已入队，不表示 worker 已读取，也不改变原授权范围。扩大范围应新建工单。
- `assistant_stop_work` 与 `assistant_retry_work` 沿用现有 Engine 校验。停止不能撤销外部操作；重试复用原 Mandate。已停止工单不能因后续输入自行恢复。
- 启动、结束及需要沟通的报告通过 `assistant-relay` 效果队列回到助手，复用幂等的 AgentDelivery；投递失败保留待重试记录。普通 progress 不唤醒助手。原有渠道回复也通过真实 Outbox 返回助手，不产生用户授权。
- worker 把本地后续消息退回路由后，路由器新建的本地来源工单也在创建事务内建立助手反馈关联。外部来源工单不会因助手阅读或面板引用而转移回复责任。
- 工单结束后保留来源与反馈关联供查询；普通事件不意味着自动开展下一阶段。助手应查询当前事实，避免把停止或改要求前的旧报告当作新目标的完成依据。

实现入口：[Assistant](../../src/app/assistant.ts)、[Runtime](../../src/app/runtime.ts)、[Sessions](../../src/app/sessions.ts)、[executor tools](../../src/app/tools/executor.ts)。

A03 已整理角色与助手接入：助手工具定义由 [assistant tools](../../src/app/tools/assistant.ts) 维护，交接业务保留在 Assistant；原始历史查询由 Sessions 适配 Harness 持久化。三个固定角色通过明确的预设与模型配置共用提示词、skill、工具装饰和释放流程，保留各角色既有权限与助手复用研判模型的约定。相关 112 项检查、类型检查与构建通过；没有改变会话恢复策略或持久化键格式。

## 上下文恢复与信息归属

Harness 持久化原始会话。`assistant_history` 按事件位置分页或搜索可见交流，过滤推理块及内部流式事件，返回原始用户消息 id；读取历史时可补回用户来源记录。查询有窗口上限，继续使用 next_offset，不宣称一次读取覆盖全部历史。

`assistant_checkpoint` 替换单项目讨论接续记录，包含当前目标、已接受决定、约束、未决问题及来源。该记录在每次助手提示词生成时可用，不依赖模型一直记住历史；写入时机仍由 agent 判断，不保证每次交流都生成记录。`assistant_work` 查询同一份真实工单状态；它是关联查询，不是平行执行数据库。

接续记录不是个人偏好记忆，也不是项目事实的权威副本。工程结论需要沉淀到原项目资产，恢复时按需核对当前资产。docs-workflow、RouteLedger 沿用用户环境提供的能力；本增量没有自动安装、初始化或复制这些系统。

## 验证与交付

自动化覆盖由 [assistant.spec.ts](../../tests/assistant.spec.ts) 及既有运行时、投递、授权和面板测试承接，包括来源真实性、事务交接、重复操作、定向输入、过时问题、停止后旧报告、普通进度隔离、派工事件幂等、反馈失败持久化、历史定位和重开数据库恢复接续记录。

验证不包含真实模型的理解和工具选择、真实客户端呈现、GitHub 认证/推送/PR，以及 DSH 全局列表隐藏。测试中的外部回调不能作为这些联调已通过的证据。构建与模拟测试通过表示实现及边界契约经过验证，真实使用效果仍待后续试用。

本机 Windows 的完整旧测试基线存在 Unix 命令、符号链接权限和路径分隔符相关失败；修改前代码的隔离对照复现 43 个失败。保留在忽略目录 `.artifacts/baseline/baseline-results.json`，不将其解释为助手新增缺陷，也不借本轮重构旧平台测试。

助手首版全量结果为 1171 通过、43 失败，失败名称与修改前基线完全一致，报告在 `.artifacts/test-results-final.json`。后续来源 skill 接入与状态查询补充后，相关 46 项检查再次通过；类型检查与构建通过。新增 15 项助手集成测试及 2 项面板交互测试均通过。原始交接正文当前提取文本；图片或附件需提供 worker 可读取的引用，未实现附件自动转交。

随后完成 Windows 路径入口适配，涵盖 stateDir、助手工作区和执行目录的原生绝对路径、相对 CLI 路径拒绝，以及 Windows 路径大小写比较。新增 13 项路径测试；与授权、助手相关检查共 356 项通过，另对路径及运行时并发执行的 69 项检查通过，类型检查、编译和更新安装包导入通过。配置示例及尚未验证的 `env`/`sh` 执行链限制见 [部署说明](../006-deployment.md#windows-path-configuration)。

本地检查使用 `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/vitest/vitest.mjs run` 和 `node node_modules/tsdown/dist/run.mjs`。安装包通过 `npm pack --ignore-scripts --pack-destination .artifacts --cache .npm-cache` 生成，产物为 `.artifacts/dsh-superagent-0.1.0.tgz`。解包后使用现有依赖导入真实插件入口作冒烟检查，不启动或安装到用户的 Harness。
