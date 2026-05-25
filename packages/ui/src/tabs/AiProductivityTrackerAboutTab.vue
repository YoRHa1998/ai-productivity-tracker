<script setup lang="ts">
import '../styles/aip-shared.css'

interface InfoItem {
  title: string
  description: string
}

interface InfoSection {
  num: string
  title: string
  description: string
  tone: 'primary' | 'accent' | 'neutral'
  items: InfoItem[]
}

const sections: InfoSection[] = [
  {
    num: '01',
    title: '工具定位',
    description: '本机优先的 AI 提效看板,按 Jira 需求维度量化开发提效。',
    tone: 'primary',
    items: [
      {
        title: '看板维度',
        description:
          '按 Jira 需求维度查看提效倍数、对话次数、Token 成本、本轮 git diff 与本轮 AI 对话总结。'
      },
      {
        title: '数据口径',
        description:
          '提效倍数 = 人工预估工时 / AI 实际耗时,叠加 Bug 数与 Token 成本惩罚;系数与单价可在「业务配置」Tab 在线调整。'
      },
      {
        title: 'Token 计量',
        description:
          'input + output + cache_creation + cache_read,与 Claude / Cursor 官方计费一致。'
      },
      {
        title: '对话总结(软数据)',
        description:
          '每轮涉及代码改动的对话结束时,AI 自动生成 100-300 字总结,通过 MCP tool ai_productivity_attach_summary 回填到本轮 iteration。'
      },
      {
        title: '复盘经验(P0)',
        description:
          '需求结束时在 IDE 内说「经验提取」,AI 自动按 5 个维度(pitfall / rule / best-practice / split-suggestion / tooling)沉淀经验到本机统一经验库,跨需求可复用。'
      }
    ]
  },
  {
    num: '02',
    title: '架构与数据流',
    description: '单 npm 包 + 单 daemon + 本机文件,完全不依赖任何远端服务。',
    tone: 'accent',
    items: [
      {
        title: '一行 npm 即安装',
        description:
          'npm i -g @ai-productivity-tracker/cli 安装一个独立包,bin 提供 aipt 与 ai-productivity-tracker 两个等价命令;`aipt install` 一键写入 mcp.json / hooks.json / skill / rule,无任何额外守护进程或下载步骤。'
      },
      {
        title: '需求创建',
        description:
          '在 IDE 内给 AI 一个 Jira URL,AI 调用 ai_productivity_init MCP tool,daemon 立即在本机创建 ~/.ai-productivity-tracker/data/<JIRA-KEY>/requirement.json,并把当前分支绑定到对应 jiraKey。'
      },
      {
        title: '过程自动采集',
        description:
          'Cursor:~/.cursor/hooks.json afterAgentResponse 在每次回答后执行 node <cli.mjs> hook → POST 给 daemon;Claude Code:daemon 内置 TranscriptWatcher 监听 ~/.claude/projects/**/*.jsonl 增量。两条链路都直接落本机文件,不经远端。'
      },
      {
        title: '对话总结上报',
        description:
          '~/.claude/skills/ai-productivity-track/ + ~/.cursor/rules/ai-productivity-track.mdc 由 aipt install 自动注入;AI 每轮答复前调用 ai_productivity_attach_summary,把一句话总结 + 改动范围回填到最新非 init iteration。'
      },
      {
        title: '看板同源托管',
        description:
          '浏览器直接 fetch http://127.0.0.1:17350/ai-productivity/*(同 daemon 同源)。daemon 聚合 INDEX.json + 各 jiraKey 下的 jsonl 实时计算指标,前端零跨域、零 token,refresh 即可看到最新数据。'
      }
    ]
  },
  {
    num: '03',
    title: '边界与隐私',
    description: '当前工具不打算做的事,避免职责越界。',
    tone: 'neutral',
    items: [
      {
        title: '不做需求管理',
        description:
          '不承担 PRD、任务板的职能,唯一关联键是 Jira Issue Key(分支名 + MCP 调用都需要包含)。'
      },
      {
        title: '一行 npm 安装、零守护进程维护',
        description:
          '装一个 npm 包即同时启用 MCP server / Hook / Watcher 自动采集;daemon 由 aipt mcp 通过 ensureDaemon 按需 spawn-detached,SIGTERM 优雅停机,重启从 transcript-state.json + hook-dedupe.json 恢复,不会重复计数。'
      },
      {
        title: '本机自治、数据不外传',
        description:
          '所有需求 / iteration / 公式 / Jira 凭证 / 经验只存在 ~/.ai-productivity-tracker/data/ 下;daemon 默认只监听 127.0.0.1:17350;断网情况下整套流程照常工作,不依赖任何中转服务。'
      },
      {
        title: '体检 & 迁移',
        description:
          'aipt doctor 一行命令 9 项体检(Node / home / runtime / data / mcp.json / hooks.json / skill / rule / 老数据);老 truesight-agent 用户跑 aipt migrate 一键平迁老数据到新根。'
      }
    ]
  }
]
</script>

<template>
  <section class="aip-about">
    <div class="aip-hero">
      <div class="aip-hero__left">
        <div class="aip-hero__icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 13h2l3-8 4 16 3-12 2 8 2-4h2"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <div class="aip-hero__info">
          <div class="aip-hero__title-row">
            <h3>AI 提效面板</h3>
            <span class="aip-chip aip-chip--solid">本地优先</span>
          </div>
          <p>
            把 AI 开发过程数据统一沉淀到本机,按 Jira 需求量化提效倍数、Token 成本与每轮对话总结。
          </p>
        </div>
      </div>
    </div>

    <div class="aip-about__grid">
      <article
        v-for="section in sections"
        :key="section.num"
        class="aip-about__card"
        :class="`aip-about__card--${section.tone}`"
      >
        <header class="aip-about__card-head">
          <span class="aip-about__num">{{ section.num }}</span>
          <div class="aip-about__head-text">
            <h4>{{ section.title }}</h4>
            <p>{{ section.description }}</p>
          </div>
        </header>
        <ul class="aip-about__items">
          <li v-for="item in section.items" :key="item.title">
            <strong>{{ item.title }}</strong>
            <span>{{ item.description }}</span>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>

<style scoped>
.aip-about {
  display: grid;
  gap: 20px;
  padding: 24px;
}

.aip-about__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}

.aip-about__card {
  display: grid;
  gap: 14px;
  padding: 20px 22px;
  border-radius: 14px;
  background: rgba(96, 114, 153, 0.04);
  border: 1px solid rgba(96, 114, 153, 0.1);
  transition:
    transform 0.2s,
    box-shadow 0.2s;
}

.aip-about__card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 22px rgba(96, 114, 153, 0.1);
}

.aip-about__card--primary {
  background: linear-gradient(135deg, rgba(79, 110, 245, 0.06), rgba(79, 110, 245, 0.02));
  border-color: rgba(79, 110, 245, 0.18);
}

.aip-about__card--accent {
  background: linear-gradient(135deg, rgba(52, 199, 89, 0.06), rgba(52, 199, 89, 0.02));
  border-color: rgba(52, 199, 89, 0.18);
}

.aip-about__card-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.aip-about__num {
  flex-shrink: 0;
  font-size: 32px;
  font-weight: 800;
  line-height: 1;
  color: rgba(96, 114, 153, 0.2);
  letter-spacing: -0.02em;
}

.aip-about__card--primary .aip-about__num {
  color: rgba(79, 110, 245, 0.28);
}

.aip-about__card--accent .aip-about__num {
  color: rgba(52, 199, 89, 0.28);
}

.aip-about__head-text {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.aip-about__head-text h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.4;
}

.aip-about__head-text p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.aip-about__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.aip-about__items li {
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-elevated, rgba(255, 255, 255, 0.6));
  border: 1px solid var(--border-subtle, rgba(96, 114, 153, 0.08));
}

.aip-about__items strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.5;
}

.aip-about__items span {
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .aip-about {
    padding: 18px;
    gap: 14px;
  }
}
</style>
