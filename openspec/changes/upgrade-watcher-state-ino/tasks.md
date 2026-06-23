## 1. Core:state schema 升级

- [x] 1.1 在 `packages/core/src/watcher-state.ts` 给 `WatcherFileState` 增可选字段 `size?` / `ino?`;`loadWatcherState` 保持对缺字段旧 state 的兼容(不报错、保留 offset/mtimeMs)
- [x] 1.2 在 `packages/core/src/codex-watcher.ts` 给 `CodexFileState` 同步增 `size?` / `ino?`,`sessions` 字段不动

## 2. Core:processFile 判定升级

- [x] 2.1 在 `transcript-watcher.ts` 的 `processFile` 实现统一判定:inode 变化 → offset=0;截断(size<offset)→ offset=0;未变(offset===size && ino 一致或旧 state 无 ino && mtime 一致)→ skip;写回 `{ offset, size, ino, mtimeMs }`
- [x] 2.2 在 `codex-watcher.ts` 的 `processFile` 应用等价判定与写回
- [x] 2.3 Windows/异常兜底:`ino` 为 0/falsy 时不参与重置判定,退回旧 `offset+mtime` 逻辑

## 3. 测试

- [x] 3.1 `watcher-state.spec.ts`:load/save 含新字段、加载旧字段 state 不丢 offset
- [x] 3.2 `transcript-watcher.spec.ts`:正常追加续读、inode 变化从头读、截断从头读、旧 state 兼容补齐、未变跳过
- [x] 3.3 `codex-watcher.spec.ts`:同上场景 + 验证 `sessions` 累计基线行为不变

## 4. 回归与发布

- [x] 4.1 `pnpm --filter @ai-productivity-tracker/core test` 通过
- [x] 4.2 `pnpm typecheck && pnpm lint && pnpm format:check` 全绿(本次改动文件全部通过;format:check 残留告警均为本变更外的未跟踪文档)
- [x] 4.3 `pnpm --filter @ai-productivity-tracker/cli build` 产物可启动;本地 daemon 跑通既有 Claude/Codex 采集无回归(build 成功、`cli.mjs version`/`doctor` 全绿、mcp stdio 正常 boot 并连上 daemon)
- [x] 4.4 单独发一个 rc(`pnpm release 1.3.0-rc.1 --publish`),作为 `add-ai-usage-overview` 的前置依赖(已发布到 npm,`latest` 指向 1.3.0-rc.1;本地 commit 1899f47 + tag v1.3.0-rc.1,未 push)
