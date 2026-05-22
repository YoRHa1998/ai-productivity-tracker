# DATA MODEL

> 本机数据文件 schema 详细字段描述。
> **待 Phase 1 store 迁入后补齐**。

## 概览(目标态)

```
~/.ai-productivity-tracker/
├── config.json
├── runtime.json
├── logs/
└── data/
    ├── index.json
    ├── bindings.json
    ├── formula.json
    ├── jira.json
    ├── pending-summary.json
    ├── transcript-state.json
    ├── recent-attach-sentinel/
    ├── lessons/
    │   ├── INDEX.json
    │   └── lsn-<JIRA>-<rand>.json
    └── <JIRA-KEY>/
        ├── requirement.json
        ├── iterations.jsonl
        ├── subtask-events.jsonl
        ├── numstat-snapshot.json
        └── raw/<seq>.json
```

字段语义沿用源项目 `specs/modules/ai-productivity-tracker/spec.md`(v2.18.0)。
