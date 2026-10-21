# 文档索引

[仓库研发入口](../AGENTS.md)负责稳定边界和一级地图；本页把任务路由到最小文档集。文档、源码和测试不一致时，应核实并修复漂移，不能选取有利的一方宣称完成。

## 按任务阅读

| 任务 | 首先阅读 | 按影响继续阅读 |
| --- | --- | --- |
| 了解系统或跨模块改动 | [架构](architecture.md) | 对应源码、Schema 和测试 |
| 修改界面与统一设置 | [界面契约](collaboration-environment-ui.md) | [看板提示词](board-prompt-settings.md)、[编码规则](rules/coding.md)、[测试说明](testing.md) |
| 修改协作、通知与接续 | [事件工作会话](event-workers.md) | [通知适配层](notification-adapters.md)、[通知消费桥](notification-consumer.md)、[会话后端](harness-adapters.md) |
| 接入外部成员 | [外部协作者](external-collaborators.md) | [会话后端](harness-adapters.md)、[通知适配层](notification-adapters.md)、对应授权与接口测试 |
| 安装、升级与恢复 | [中文安装指南](setup.zh-CN.md)／[English setup](setup.md) | [发布规则](rules/release.md)、[事件工作会话](event-workers.md) |
| 编码或评审 PR | [编码规则](rules/coding.md) | 相关主题契约、[测试规则](rules/testing.md) |
| 选择测试与解释结果 | [测试规则](rules/testing.md) | [测试层级和命令](testing.md)、[历史验证记录](verification.md) |
| 调整文档或形成长期取舍 | [文档维护](harness.md) | [规则索引](rules/README.md)、[技术决策索引](decisions/index.md) |

## 主责与维护

- 产品行为由现有主题文档主责；不为整理目录复制第二份契约。运行时协作 prompt／skill 与研发入口分开维护。
- 当前任务、参与者和即时进展由 Swarmboard 管理；文档保留稳定契约、必要取舍及验收证据。不另建重复任务台账，也不建立日报、周报、会议或客户材料目录。
- [技术决策](decisions/index.md)只记录持久取舍；[历史验证记录](verification.md)中的旧版本结果不能代替当前验收。
- 新文档应从本页或已索引文档可达，一个事实只有一个主责位置。具体检查和同步矩阵见 [文档维护](harness.md)。
