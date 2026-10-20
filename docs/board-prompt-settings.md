# 看板提示词配置数据与接口

设置中的“系统提示词”沿用原个人偏好记录，不复制数据、不重置版本或来源。“用户提示词”为独立文本和版本，默认空；当前资源定义与使用/共享约定由人类在该字段维护，不从旧结构化资源、任务或历史自动生成或回灌。名称是看板配置名称，不代表覆盖厂商内置 system、安全规则或执行授权。逐回合使用何种官方指令接口及提交前版本复核由运行时负责，不能用读接口成功冒充模型已经应用。

模式 11 在已发布模式 10 后追加 `board_user_prompt`。新记录为 `{text:'',source:null,version:0,updatedAt:null}`，`boardId` 仍来自原看板身份。升级只增加新表，原 `board_preferences`、资源、使用声明、任务及追加历史均保留。迁移与版本更新沿同一事务完成，失败全部回滚；模式号和新表不匹配的未发布候选明确拒绝，不覆盖或猜测其数据。

| 配置 | Store | MCP | HTTP |
| --- | --- | --- | --- |
| 系统提示词（原个人偏好） | `readPreferences` / `writePreferences` | `preferences_read` / `preferences_write` | `GET` / `PATCH /api/preferences` |
| 用户提示词 | `readUserPrompt` / `writeUserPrompt` | `user_prompt_read` / `user_prompt_write` | `GET` / `PATCH /api/user-prompt` |

两个读值的结构均为 `{boardId,text,source,version,updatedAt}`。两个写入均接收 `{text,source,expectedVersion}`，来源只允许 `human-input` 或 `main-chat-relay`，文本最多 20000 字符。来源是声明记录，不是权限凭证。每个字段使用自己的 CAS 版本；保存或清空一个字段不改另一个。空文本保留递增的新版本，旧草稿不能把清空前内容写回来；失败不自动重试。

`readPromptSettings()` 在同一 SQLite 事务中返回 `{systemPrompt,userPrompt}`，供运行时准备一致的两字段快照。完整看板和有界看板分别返回兼容的 `preferences` 与新增的 `userPrompt`。有界 MCP 的实时授权检查失效或未提供时，两种提示词读工具均拒绝读取，收尾用途的 `board_read` / `board_open` 同时移除这两个字段；不会通过旧看板入口泄漏当前配置。两种写工具均只向可信人类宿主提供，原生池成员和外部协作者不能写。HTTP 沿用环回、同源与可选 Bearer 校验。

成功的用户提示词写入与 `BOARD_USER_PROMPT_UPDATED` 事件原子提交，事件只包含版本、来源和是否清空，不复制文本；提交成功后通知运行时。系统提示词沿原 `BOARD_PREFERENCES_UPDATED` 事件。运行时接续、官方指令装入和忙碌后更新需要另行验证，这里的存储与协议测试不代替它们。

## 当前资源来源与历史兼容

当前资源定义仅来自用户提示词；占用、共享约定、冲突协商及结束说明通过 `context_publish` 记录，不要求旧 `resourceId`。这不扩大任务、主机、凭据或生产授权。

`board_read`、`board_open` 与 `GET /api/board` 保留 `resources` / `usages` 原字段，只作历史审计兼容，并返回 `resourceDefinitions: {source:'userPrompt', legacyFields:['resources','usages'], coordination:'context_publish'}`。原数据、ID、版本、使用记录与追加历史不硬删除，也不把旧表解释成与用户提示词并列的当前配置。

旧 MCP `resource_create`、`resource_update`、`resource_use`、`resource_usage_update` 保留兼容名称和输入 Schema，但统一拒绝 `LEGACY_RESOURCE_READ_ONLY`；对应 HTTP `POST /api/resources`、`PATCH /api/resources/:id`、`POST /api/usages`、`PATCH /api/usages/:id` 返回 410。失败不产生资源、使用记录或事件。`resource_release` 与 `POST /api/usages/:id/release` 仅用于释放已有历史占用，继续校验身份、所有权和版本，不停止真实进程。

现有看板若由人类选择一次性导入，可信宿主先读取完整用户提示词和历史定义，保留原内容、使用独立 CAS 并回读；禁止重复追加、覆盖非空文本或引入凭据。该人工操作不是升级自动迁移：没有新 Schema、文本解析同步或启动时回填。已经编辑或显式清空的版本是权威值；重开、重启与旧资源写入失败都不能恢复历史定义。两个提示词仍按现有正常回合的同源快照机制注入；历史资源行不进入提示词注入。

UI 删除旧资源管理入口、实际安装与人类现场验收独立交付；本协议的测试通过不代表它们已完成。

## 已保存的原生自动化模板

新的自动领取模板每轮读取 `automation_read.workerPrompt`、`preferences_read` 与 `user_prompt_read`，通过 `context_publish` 协商资源与结束使用，不再要求旧资源 ID 或旧资源写工具。`automation_read` 在原配置字段之外只读返回本版本生成的 `workerPrompt`；读取不会修改配置、原生日程、状态或版本。

插件升级不会自动改写已经保存到宿主的日程 prompt。旧模板若仍要求 `resource_use`，受信宿主应在得到该日程更新授权后，先通过官方原生工具查看精确 `automationId` 和当前完整字段，再从 `automation_read` 取得匹配 boardId/workspacePath 的最新 `workerPrompt`，仅按原 ID 更新 prompt。保留状态（尤其 `PAUSED`）、模型、推理强度、项目、频率、会话和在途工作，更新后正式读回核对；不得为刷新模板调用启用、恢复、重建或重放。未获恢复授权的暂停日程保持暂停；身份或更新结果不确定时先对账。现存旧回合遇到退役资源写拒绝，应记录阻塞并安全收尾，不能改用旧表回填或新建结构化资源。
