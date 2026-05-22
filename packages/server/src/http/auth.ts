import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export function extractToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7)
}

export function verifyToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}
