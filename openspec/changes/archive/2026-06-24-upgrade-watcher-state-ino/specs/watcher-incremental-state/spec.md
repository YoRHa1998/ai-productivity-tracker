## ADDED Requirements

### Requirement: 会话文件增量读取游标

watcher SHALL 为每个被追踪的会话文件持久化一个断点续采游标,游标 SHALL 至少包含:已读字节偏移 `offset`、上次观察到的文件大小 `size`、文件 inode `ino`、最近修改时间 `mtimeMs`。游标 SHALL 落盘到 watcher 的 state 文件并跨进程重启保持。

#### Scenario: 正常追加写入后从断点继续

- **WHEN** 会话文件在上次读取后追加了新内容(inode 不变、size 增大)
- **THEN** watcher 从上次 `offset` 继续读取新增部分,并把游标更新为新的 offset/size/ino/mtime

#### Scenario: 文件未变化时跳过

- **WHEN** 某文件的 `offset` 等于当前 `size`、`ino` 与 `mtimeMs` 均与游标一致
- **THEN** watcher 跳过该文件,不重复读取、不重复产出事件

### Requirement: inode 变化与截断的安全重置

watcher SHALL 检测会话文件的 inode 变化与截断,并在发生时把读取偏移安全重置,避免按陈旧偏移读入不相关内容或漏读。

#### Scenario: 同名文件被轮转/替换(inode 变化)

- **WHEN** 某路径上的文件 `ino` 与游标记录的 `ino` 不一致
- **THEN** watcher 视其为新文件,把 `offset` 重置为 0 并从头读取,更新游标 ino

#### Scenario: 文件被截断

- **WHEN** 某文件当前 `size` 小于游标记录的 `offset`
- **THEN** watcher 把 `offset` 重置为 0 并从头读取,避免读取越界或错位

### Requirement: 旧 state 向后兼容

watcher 加载缺少 `size` / `ino` 字段的旧 state 文件时 SHALL 安全降级,SHALL NOT 报错或丢弃既有进度,并在首次扫描时自动补齐新字段。

#### Scenario: 加载旧版 state 文件

- **WHEN** state 文件中某文件条目只有 `offset` 与 `mtimeMs`(无 `size` / `ino`)
- **THEN** watcher 按旧逻辑判定是否需要读取,不丢失既有 `offset`,并在本次处理后把 `size` / `ino` 补写进游标

#### Scenario: Codex sessions 字段不受影响

- **WHEN** 升级 Codex 文件游标 schema
- **THEN** 既有的 per-session 累计基线(`sessions` 字段)保持不变,token 增量计算行为不变
