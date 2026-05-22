import type { IncomingMessage, ServerResponse } from 'node:http'

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

export function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split('/')
  const pathParts = pathname.split('/')

  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const seg = patternParts[i]!
    const cur = pathParts[i]!
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = cur
    } else if (seg !== cur) {
      return null
    }
  }
  return params
}

export function badJsonResponse(res: ServerResponse): void {
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Invalid JSON' }))
}
