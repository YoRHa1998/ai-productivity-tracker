## Context

- `packages/core/src/watcher-state.ts` 定义 `WatcherFileState { offset, mtimeMs }` 与 `WatcherState { version, files: Record<filePath, WatcherFileState> }`,`load/saveWatcherState` 用 tmp+rename 原子写。Claude 的 `TranscriptWatcher` 复用它,落盘 `transcript-state.json`。
- `transcript-watcher.ts:309-357` 的 `processFile`:`prev = state.files[filePath]`,skip 判定 `prev.offset === stats.size && prev.mtimeMs === stats.mtimeMs`,否则 `readJsonlIncremental(filePath, prev?.offset ?? 0)`,读完写回 `{ offset:newOffset, mtimeMs }`。
- `codex-watcher.ts` 用独立 `codex-state.json`,`CodexFileState { offset, mtimeMs }` + `sessions: Record<sid, { flushedTotal }>`;`processFile` 判定同构(`prev.offset === stats.size && prev.mtimeMs === stats.mtimeMs`)。
- 两者均按**绝对文件路径**作键。隐患:同名路径文件被轮转/替换(inode 变)或被截断(size < offset)时,按陈旧 offset 读会错位/越界,或漏读。
- 参考 LoongSuite Pilot 的 StateStore:用 `offset + size + ino` 作断点续采游标,显式处理轮转。

## Goals / Non-Goals

**Goals:**

- 把文件游标从 `{ offset, mtimeMs }` 升级为 `{ offset, size, ino, mtimeMs }`,显式检测 inode 变化与截断并安全重置。
- 旧 state 向后兼容(缺字段兜底 + 首扫补齐),无需迁移、无 BREAKING。
- 正常追加场景行为零变化;仅在轮转/截断边界更稳健。
- 作为 `add-ai-usage-overview` 的前置可靠性增强,独立成 change、单独发 rc。

**Non-Goals:**

- 不改 state 文件路径、不改 `version` 语义到不兼容程度(仅加字段)。
- 不改 Codex `sessions` 累计基线逻辑。
- 不引入跨文件去重快照(SnapshotStore 级能力),本变更只做 StateStore 级游标增强。

## Decisions

### D1:扩展 `WatcherFileState`,保持可选兼容

```ts
export interface WatcherFileState {
  offset: number
  mtimeMs: number
  size?: number // 新增,旧 state 缺失为 undefined
  ino?: number // 新增,旧 state 缺失为 undefined
}
```

- `loadWatcherState` 不强校验 `size`/`ino`(缺失即 undefined),保留既有 `offset`/`mtimeMs`。
- `CodexFileState` 同样加 `size?` / `ino?`。

### D2:`processFile` 统一判定顺序

抽出一个共享判定(或两 watcher 各自等价实现):

```
stats = statSync(file)
prev = state.files[file]
// 1) inode 变化:轮转/替换 → 从头读
if (prev?.ino !== undefined && prev.ino !== stats.ino) startOffset = 0
// 2) 截断:size 缩小 → 从头读
else if (prev && stats.size < prev.offset) startOffset = 0
// 3) 未变:offset 到底 + ino 一致(或旧 state 无 ino)+ mtime 一致 → skip
else if (prev && prev.offset === stats.size
         && (prev.ino === undefined || prev.ino === stats.ino)
         && prev.mtimeMs === stats.mtimeMs) return
else startOffset = prev?.offset ?? 0
// 读 readJsonlIncremental(file, startOffset)
// 写回 { offset:newOffset, size:stats.size, ino:stats.ino, mtimeMs:stats.mtimeMs }
```

- 旧 state(无 `ino`)走兜底:跳过判定退化为原 `offset===size && mtime` 逻辑,处理后补齐 `size`/`ino`。
- `stats.ino` 由 `node:fs` `Stats.ino` 提供(跨平台;Windows 上 ino 可能为 0/不稳定,作兜底:ino 为 0/缺失时退回旧逻辑,不因此误重置)。

### D3:发布顺序

本变更先发一个 rc 并跑回归;`add-ai-usage-overview` 在其之上实现采集旁路。两者不在同一 rc,避免新功能放大本可靠性改动的回归面。

## Risks / Trade-offs

- [Windows ino 不稳定] → ino 为 0/falsy 时不参与重置判定,退回旧 `offset+mtime` 逻辑,保证不回归。
- [误重置导致重复采集] → 仅在 ino 确实变化或 size<offset 时重置;正常追加不触发;新增轮转/截断单测覆盖。
- [旧 state 首扫补齐窗口] → 补齐发生在正常处理路径内,不额外扫描;补齐前后 offset 不变,无数据影响。

## Migration Plan

- 纯加字段,无需迁移脚本;旧 `transcript-state.json` / `codex-state.json` 直接可读。
- 回滚:恢复旧 `WatcherFileState` 与判定即可;已写入的 `size`/`ino` 字段被旧代码忽略,无害。
- 发版:单独 `pnpm release prerelease --publish` 出一个 rc。

## Open Questions

1. 是否顺带把 state `files` 的键从「绝对路径」改为「路径 + ino 复合」以更彻底处理轮转?——倾向不改键(改键涉及历史 state 失效),用 D2 的 ino 比对已足够。
