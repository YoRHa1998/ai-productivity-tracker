import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const AIP_DIR_NAME = '.ai-productivity'
export const BINDINGS_FILE = 'bindings.json'

export function findAipDir(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir)

  while (true) {
    const candidate = resolve(current, AIP_DIR_NAME)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate
    }

    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

export function bindingsPath(aipDir: string): string {
  return resolve(aipDir, BINDINGS_FILE)
}
