import { VERSION } from '../version.js'

const HELP_TEXT = `\
ai-productivity-tracker v\${VERSION}

USAGE
  ai-productivity-tracker <command> [options]
  aipt <command> [options]                       # 别名,等价

COMMANDS
  mcp                启动 stdio MCP server(IDE 内部调用,自动 spawn daemon)
  daemon             前台启动 HTTP daemon(包含面板与 API)
    --port <n>       指定监听端口(默认 17350 或 config.json 中的 port)
    --token <s>      指定鉴权 token(默认自动生成 / 复用上次)
    --no-web         不挂载看板静态资源
  hook               处理 IDE afterAgentResponse hook(短 CLI,fail-open)
  stop-check         处理 IDE stop hook 防伪造校验
  install            一键注入 hook + skill 到 IDE 配置
    --ide=cursor|claude|all   (默认 all)
    --debug                   注入 debug 前缀(打印 stdin payload 排错)
    --no-restart-daemon       跳过 Step 0 的版本对齐(默认会停掉本机版本不一致的 daemon)
  install-mcp        将本 cli 写到 IDE 本机 MCP 配置(同时支持 Cursor 与 Claude Code)
    --ide=cursor|claude|all   (默认 all → 同时写 ~/.cursor/mcp.json + ~/.claude.json)
  ui open            在浏览器打开看板
  migrate            把 ~/.truesight-local-agent 老数据搬到新根
  doctor             体检 daemon / hook / skill / mcp.json / 数据迁移
  version            打印版本
  --help, -h         打印本帮助

DOCS
  See https://github.com/zhongleijian/ai-productivity-tracker (or docs/PRD.md)
`

export async function runHelp(): Promise<number> {
  console.log(HELP_TEXT.replace('${VERSION}', VERSION))
  return 0
}
