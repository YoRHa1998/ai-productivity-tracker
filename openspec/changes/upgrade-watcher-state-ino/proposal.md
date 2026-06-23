## Why

Claude(`TranscriptWatcher`)与 Codex(`CodexWatcher`)的增量采集用 `~/.ai-productivity-tracker/data/transcript-state.json` / `codex-state.json` 记录每个会话文件的读取进度,当前只存 `{ offset, mtimeMs }` 并按文件路径作键。这在「同名文件被替换/轮转(inode 变化)」或「文件被截断(size < offset)」时存在隐患:可能从一个陈旧 offset 读入另一份内容,或漏读/重复读,导致整体用量与 iteration 计数出现重复或丢失。

借鉴 LoongSuite Pilot 的 StateStore 思路(用 `offset + size + ino` 作为断点续采游标),把文件追踪升级为 `offset + size + ino`,显式识别 inode 变化与截断并安全重置,增强采集幂等。该升级是通用可靠性增强,与「AI 整体用量」功能解耦,作为其**前置变更单独发布一个 rc**,便于独立回归、降低耦合风险。

## What Changes

- **`WatcherFileState` schema 升级**:从 `{ offset, mtimeMs }` 扩展为 `{ offset, size, ino, mtimeMs }`(向后兼容:旧 state 缺 `size`/`ino` 时按旧逻辑兜底,首次扫描自动补齐)。
- **两个 watcher 的 `processFile` 判定升级**:
  - inode 变化(`ino` 与记录不一致)→ 视为新文件,offset 重置为 0 重新读。
  - 截断(`stats.size < prev.offset`)→ offset 重置为 0 重新读。
  - 未变(`offset===size && ino 一致 && mtimeMs 一致`)→ 跳过。
- **Codex `CodexFileState` 同步升级**(同结构,保留既有 `sessions` 字段不变)。
- 行为对外不变:正常追加写入场景下采集结果与升级前一致,仅在轮转/截断边界更稳健。

## Capabilities

### New Capabilities

- `watcher-incremental-state`: watcher 对会话文件的增量读取进度追踪与断点续采能力——定义 state 游标(offset+size+ino+mtime)、inode/截断变化的检测与安全重置、跨重启幂等。

### Modified Capabilities

<!-- openspec/specs/ 当前为空,无既有 spec 能力的需求变更。 -->

## Impact

- **`packages/core`**:`watcher-state.ts`(`WatcherFileState` + load/save 兼容旧字段)、`transcript-watcher.ts`(`processFile` 判定 + 写回)、`codex-watcher.ts`(`CodexFileState` 同步升级,`sessions` 不动)。
- **数据兼容**:旧 `transcript-state.json` / `codex-state.json` 无需迁移,加载时缺字段兜底;无 BREAKING。
- **下游依赖**:`add-ai-usage-overview` 变更依赖本前置 rc 落地后再实现整体用量采集旁路。
- **测试**:`watcher-state.spec.ts` / `transcript-watcher.spec.ts` / `codex-watcher.spec.ts` 新增轮转/截断/旧 state 兼容用例。
