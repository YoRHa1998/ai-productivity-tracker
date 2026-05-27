import { describe, expect, it } from 'vitest'

import {
  CLAUDE_TRACK_HOOK_REMINDER_COMMAND,
  CLAUDE_TRACK_HOOK_REMINDER_MARKER,
  CLAUDE_TRACK_SKILL_CONTENT,
  CURSOR_SESSION_REMINDER_COMMAND,
  CURSOR_SESSION_REMINDER_MARKER,
  CURSOR_TRACK_RULE_CONTENT,
  LESSONS_EXTRACT_CLAUDE_CONTENT,
  LESSONS_EXTRACT_CURSOR_CONTENT,
  LESSONS_EXTRACT_SKILL_VERSION,
  TRACK_SKILL_VERSION
} from './track-skill-templates.js'

describe('v2.15.0 文案 invariant — Cursor / Claude 双方言对称', () => {
  it('TRACK_SKILL_VERSION 应该为 2.15.0', () => {
    expect(TRACK_SKILL_VERSION).toBe('2.15.0')
  })

  describe('CURSOR_TRACK_RULE_CONTENT', () => {
    it('alwaysApply: true 维持不变', () => {
      expect(CURSOR_TRACK_RULE_CONTENT).toContain('alwaysApply: true')
    })

    it('版本号写入正文', () => {
      expect(CURSOR_TRACK_RULE_CONTENT).toContain(`v${TRACK_SKILL_VERSION}`)
    })

    it('首段为正向「## 触发(每轮必须)」,出现在「边界」段之前', () => {
      const triggerIdx = CURSOR_TRACK_RULE_CONTENT.indexOf('## 触发(每轮必须)')
      const boundaryIdx = CURSOR_TRACK_RULE_CONTENT.indexOf('## 边界')
      expect(triggerIdx).toBeGreaterThan(0)
      expect(boundaryIdx).toBeGreaterThan(triggerIdx)
    })

    it('正向句式「必须调用一次」存在', () => {
      expect(CURSOR_TRACK_RULE_CONTENT).toMatch(/每轮.*必须调用一次/)
    })

    it('提及 sessionStart Hook 注入 reminder 作为前置满足信号', () => {
      expect(CURSOR_TRACK_RULE_CONTENT).toContain('sessionStart')
      expect(CURSOR_TRACK_RULE_CONTENT).toContain('[ai-productivity]')
    })

    it('保留「完成态零提示」段(不要输出"已上报"等字样)', () => {
      expect(CURSOR_TRACK_RULE_CONTENT).toContain('## 完成态')
      expect(CURSOR_TRACK_RULE_CONTENT).toContain('已上报')
    })

    it('v2.14.0 删除「防伪造硬约束 → sentinel + Stop Hook 强制重答」整段(无兜底叙述)', () => {
      expect(CURSOR_TRACK_RULE_CONTENT).not.toContain('防伪造硬约束')
      expect(CURSOR_TRACK_RULE_CONTENT).not.toContain('强制你在下一轮被打回来')
      expect(CURSOR_TRACK_RULE_CONTENT).not.toContain('被打回来补一次')
    })

    it('删除「v2.13.0 双向对称」之类的版本演进叙述,保持文案简洁', () => {
      expect(CURSOR_TRACK_RULE_CONTENT).not.toContain('双向对称')
    })
  })

  describe('CLAUDE_TRACK_SKILL_CONTENT', () => {
    it('版本号写入正文', () => {
      expect(CLAUDE_TRACK_SKILL_CONTENT).toContain(`v${TRACK_SKILL_VERSION}`)
    })

    it('首段为正向「## 触发(每轮必须)」', () => {
      const triggerIdx = CLAUDE_TRACK_SKILL_CONTENT.indexOf('## 触发(每轮必须)')
      const boundaryIdx = CLAUDE_TRACK_SKILL_CONTENT.indexOf('## 边界')
      expect(triggerIdx).toBeGreaterThan(0)
      expect(boundaryIdx).toBeGreaterThan(triggerIdx)
    })

    it('正向句式「必须调用一次」存在', () => {
      expect(CLAUDE_TRACK_SKILL_CONTENT).toMatch(/每轮.*必须调用一次/)
    })

    it('提及 UserPromptSubmit Hook reminder 作为前置满足信号', () => {
      expect(CLAUDE_TRACK_SKILL_CONTENT).toContain('UserPromptSubmit')
      expect(CLAUDE_TRACK_SKILL_CONTENT).toContain('即将开始本轮对话')
    })

    it('v2.14.0 删除「防伪造硬约束」整段', () => {
      expect(CLAUDE_TRACK_SKILL_CONTENT).not.toContain('防伪造硬约束')
      expect(CLAUDE_TRACK_SKILL_CONTENT).not.toContain('强制你在下一轮被打回来')
      expect(CLAUDE_TRACK_SKILL_CONTENT).not.toContain('被打回来补一次')
    })

    it('source 字段值为 claude-code', () => {
      expect(CLAUDE_TRACK_SKILL_CONTENT).toContain('"claude-code"')
    })
  })

  describe('v2.15.0 经验内联段(强候选才问 · 双方言对称)', () => {
    for (const [name, content] of [
      ['Cursor', CURSOR_TRACK_RULE_CONTENT],
      ['Claude', CLAUDE_TRACK_SKILL_CONTENT]
    ] as const) {
      describe(name, () => {
        it('含「## 经验内联(强候选才问 · v2.15.0)」段', () => {
          expect(content).toContain('## 经验内联(强候选才问 · v2.15.0)')
        })

        it('含固定单行格式「💡 本轮可沉淀一条经验」(便于兜底文案对齐)', () => {
          expect(content).toContain('💡 本轮可沉淀一条经验:<≤40字>。回复"记录"即保存。')
        })

        it('指示用户回复「记录」后调 save_lessons 单条 + iterationSeqs,且不调 extract_bundle', () => {
          expect(content).toContain('ai_productivity_save_lessons')
          expect(content).toContain('iterationSeqs')
          expect(content).toContain('不要调')
          expect(content).toContain('ai_productivity_extract_bundle')
        })

        it('保留「非 Jira 分支同样不适用」降噪边界', () => {
          expect(content).toContain('本段同样 100% 不适用')
        })

        it('默认沉默基调:强调不强命中严禁追加', () => {
          expect(content).toMatch(/默认沉默|严禁\*\*追加/)
        })
      })
    }
  })

  describe('v1.3.0 lessons-extract 与内联协同说明', () => {
    it('LESSONS_EXTRACT_SKILL_VERSION 应为 1.3.0', () => {
      expect(LESSONS_EXTRACT_SKILL_VERSION).toBe('1.3.0')
    })

    for (const [name, content] of [
      ['Claude', LESSONS_EXTRACT_CLAUDE_CONTENT],
      ['Cursor', LESSONS_EXTRACT_CURSOR_CONTENT]
    ] as const) {
      it(`${name} 顶部声明与 v2.15.0 经验内联共用 save_lessons 且落盘不会重复`, () => {
        expect(content).toContain('v2.15.0')
        expect(content).toContain('ai_productivity_save_lessons')
        expect(content).toContain('落盘不会重复')
      })
    }
  })

  describe('CURSOR_SESSION_REMINDER_COMMAND', () => {
    it('marker 与常量一致,且包含在命令字符串末尾', () => {
      expect(CURSOR_SESSION_REMINDER_MARKER).toBe('# ai-productivity-session-reminder')
      expect(CURSOR_SESSION_REMINDER_COMMAND).toContain(CURSOR_SESSION_REMINDER_MARKER)
    })

    it('外层 bash -c 单引号包裹', () => {
      expect(CURSOR_SESSION_REMINDER_COMMAND.startsWith("bash -c '")).toBe(true)
    })

    it('通过 CURSOR_PROJECT_DIR 环境变量探当前分支(Cursor 给所有 hook 统一注入)', () => {
      expect(CURSOR_SESSION_REMINDER_COMMAND).toContain('${CURSOR_PROJECT_DIR:-$PWD}')
      expect(CURSOR_SESSION_REMINDER_COMMAND).toContain('symbolic-ref')
    })

    it('正则匹配 Jira issue key 形态', () => {
      expect(CURSOR_SESSION_REMINDER_COMMAND).toContain('[A-Z][A-Z0-9]+-[0-9]+')
    })

    it('Jira 分支输出 additional_context JSON', () => {
      expect(CURSOR_SESSION_REMINDER_COMMAND).toContain('additional_context')
      expect(CURSOR_SESSION_REMINDER_COMMAND).toContain('[ai-productivity]')
    })

    it('非 Jira 分支与失败兜底输出空对象 {}', () => {
      // 命中两次:if/else 的 else 分支 + 整段 || 兜底
      const occurrences = CURSOR_SESSION_REMINDER_COMMAND.split('printf "%s" "{}"').length - 1
      expect(occurrences).toBeGreaterThanOrEqual(2)
    })
  })

  describe('双方言 reminder 命令对称性', () => {
    it('Claude 与 Cursor reminder 命令都基于 bash + git symbolic-ref + Jira 正则', () => {
      for (const cmd of [CLAUDE_TRACK_HOOK_REMINDER_COMMAND, CURSOR_SESSION_REMINDER_COMMAND]) {
        expect(cmd).toMatch(/^bash -c /)
        expect(cmd).toContain('symbolic-ref --short -q HEAD')
        expect(cmd).toContain('[A-Z][A-Z0-9]+-[0-9]+')
      }
    })

    it('两条 reminder 命令各自带独立 marker,不会被互相覆盖', () => {
      expect(CLAUDE_TRACK_HOOK_REMINDER_MARKER).not.toBe(CURSOR_SESSION_REMINDER_MARKER)
      expect(CURSOR_SESSION_REMINDER_COMMAND).not.toContain(CLAUDE_TRACK_HOOK_REMINDER_MARKER)
      expect(CLAUDE_TRACK_HOOK_REMINDER_COMMAND).not.toContain(CURSOR_SESSION_REMINDER_MARKER)
    })
  })
})
