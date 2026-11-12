# 文档

[English](README.md) | 简体中文

本索引指向 `dsh-device-mesh` 的规范、设计、开发和决策文档。如果你想安装和使用插件，请先看顶层 [README.zh.md](../README.zh.md)；这里的文档面向评审、扩展或运维本插件的人。

## 规范

| 文档 | 语言 | 内容 |
|---|---|---|
| [PROTOCOL.zh.md](zh/PROTOCOL.zh.md) | 简体中文 | 线路协议 v1：身份、配对凭证、传输分帧、Noise 握手、RPC 方法、portal 代理、paseo-relay 复用与安全检查清单。 |
| [DESIGN.zh.md](zh/DESIGN.zh.md) | 简体中文 | 架构：目标与约束、组件布局、传输、配对、portal、状态、威胁模型、本地/远程 UI 方案、平台矩阵、测试策略与路线图。 |

协议是规范性文档。当实现与规范不一致时，请把它当作缺陷：在同一次变更中同时更新代码和协议，或者明确记录偏差。不兼容的线路变更必须提升协议版本。

## 开发与决策

| 文档 | 内容 |
|---|---|
| [development.zh.md](zh/development.zh.md) | 维护者指南：版本基线、仓库结构、DSH 打包与 client-bundle 契约、本地回路、host/UI 集成点、测试、调试与发布政策。 |
| [adr/0001-remote-control-in-dsh.zh.md](zh/adr/0001-remote-control-in-dsh.zh.md) | 为什么 MVP 使用 host 侧设备网格加回环 portal，而不是第二棵 DSH client 树，以及第二阶段有哪些变化。 |

架构决策以 ADR 形式记录在 [`zh/adr/`](zh/adr/) 下；新增决策请写新 ADR，而不是改写已接受的 ADR。

## 项目文档

| 文档 | 内容 |
|---|---|
| [README.zh.md](../README.zh.md) | 面向用户的概览、安装、配对与中继配置。 |
| [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md) | 开发环境、命令、bundle 契约、PR 规则与测试要求。 |
| [SECURITY.zh.md](../SECURITY.zh.md) | 支持的版本、私密漏洞报告、威胁模型与部署加固。 |
| [CHANGELOG.zh.md](../CHANGELOG.zh.md) | Keep a Changelog 格式的发布历史。 |
| [RELEASE.zh.md](../RELEASE.zh.md) | 发布门槛：自动化检查、人工验证矩阵与已知限制。 |
| [LICENSE](../LICENSE) | MIT 许可证。 |

## 推荐阅读顺序

1. [README.zh.md](../README.zh.md) —— 插件能做什么、如何试用。
2. [DESIGN.zh.md](zh/DESIGN.zh.md) —— 为什么这样构建，边界在哪里。
3. [PROTOCOL.zh.md](zh/PROTOCOL.zh.md) —— 精确的线路行为，面向实现者和安全评审者。
4. [SECURITY.zh.md](../SECURITY.zh.md) —— 保证什么、不保证什么，以及如何安全部署。
5. [development.zh.md](zh/development.zh.md) —— 如何构建、扩展和发布插件；然后看 [ADR 0001](zh/adr/0001-remote-control-in-dsh.zh.md)，了解 portal 优先设计背后的架构决策。
