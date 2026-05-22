# ARCHITECTURE

> 详细架构与时序图。**待 Phase 1 业务代码迁入后补齐**。

当前完整设计请参考 [`PRD.md`](./PRD.md) §3 与 §5。

## 待补章节

- 进程拓扑时序图(daemon spawn / mcp 注册 / hook 上报)
- 端口选举与 lockfile 状态机
- transcript-watcher 内部状态机(buffer 触发 / stale flush / message.id 去重)
- sentinel + stop-check 防伪造校验时序
- skill-sync 写盘原子性与 sha256 比对
- 错误码与重试矩阵
