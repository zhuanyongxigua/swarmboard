# 研发规则索引

本目录规定研发时如何修改、验证和交付；产品功能继续由 [主题文档](../index.md)主责，运行时成员协议继续由 [shared-worker](../../skills/shared-worker/SKILL.md)主责。

| 主题 | 权威正文 | 主要验证入口 |
| --- | --- | --- |
| 编码、界面与评审 | [coding.md](coding.md) | 相关源码、Schema、ESLint、TypeScript 与 PR diff |
| 测试选择及证据 | [testing.md](testing.md) | [命令与测试层级](../testing.md)、适用回归和 CI |
| 合入、打包、安装与恢复 | [release.md](release.md) | 精确 SHA 的必需 CI、构建工件与真实验收 |
| 文档主责与索引 | [文档维护](../harness.md) | `npm run test:docs`、`npm run check:docs` |

可由 Schema、静态检查或测试执行的规则，应在最靠近风险的位置落实；本页不宣称全部研发规则都已被自动验证。
