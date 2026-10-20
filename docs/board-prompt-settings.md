# 看板提示词配置数据与接口

设置中的“系统提示词”沿用原个人偏好记录，不复制数据、不重置版本或来源。“用户提示词”为独立文本和版本，默认空；不从资源定义、任务或历史自动生成指令。名称是看板配置名称，不代表覆盖厂商内置 system、安全规则或执行授权。逐回合使用何种官方指令接口及提交前版本复核由运行时负责，不能用读接口成功冒充模型已经应用。

模式 11 在已发布模式 10 后追加 `board_user_prompt`。新记录为 `{text:'',source:null,version:0,updatedAt:null}`，`boardId` 仍来自原看板身份。升级只增加新表，原 `board_preferences`、资源、使用声明、任务及追加历史均保留。迁移与版本更新沿同一事务完成，失败全部回滚；模式号和新表不匹配的未发布候选明确拒绝，不覆盖或猜测其数据。

| 配置 | Store | MCP | HTTP |
| --- | --- | --- | --- |
| 系统提示词（原个人偏好） | `readPreferences` / `writePreferences` | `preferences_read` / `preferences_write` | `GET` / `PATCH /api/preferences` |
| 用户提示词 | `readUserPrompt` / `writeUserPrompt` | `user_prompt_read` / `user_prompt_write` | `GET` / `PATCH /api/user-prompt` |

两个读值的结构均为 `{boardId,text,source,version,updatedAt}`。两个写入均接收 `{text,source,expectedVersion}`，来源只允许 `human-input` 或 `main-chat-relay`，文本最多 20000 字符。来源是声明记录，不是权限凭证。每个字段使用自己的 CAS 版本；保存或清空一个字段不改另一个。空文本保留递增的新版本，旧草稿不能把清空前内容写回来；失败不自动重试。

`readPromptSettings()` 在同一 SQLite 事务中返回 `{systemPrompt,userPrompt}`，供运行时准备一致的两字段快照。完整看板和有界看板分别返回兼容的 `preferences` 与新增的 `userPrompt`。有界 MCP 的实时授权检查失效或未提供时，两种提示词读工具均拒绝读取，收尾用途的 `board_read` / `board_open` 同时移除这两个字段；不会通过旧看板入口泄漏当前配置。两种写工具均只向可信人类宿主提供，原生池成员和外部协作者不能写。HTTP 沿用环回、同源与可选 Bearer 校验。

成功的用户提示词写入与 `BOARD_USER_PROMPT_UPDATED` 事件原子提交，事件只包含版本、来源和是否清空，不复制文本；提交成功后通知运行时。系统提示词沿原 `BOARD_PREFERENCES_UPDATED` 事件。运行时接续、官方指令装入和忙碌后更新需要另行验证，这里的存储与协议测试不代替它们。

原资源表及使用声明不删除、不改 ID，也不拼成自由文本。设置界面应提供可达的原资源只读明细或其他可回溯入口，用户提示词另开空字段。前端入口、容量控制、两字段装入、README 展示图、合入、安装和真实界面验收分别交付，不能因为本接口存在而报告全部设置完成。
