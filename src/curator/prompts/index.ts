/**
 * Prompt 文本（7.9）。英文写成、启动时读入并冻结；面向观众的字段用 locale。
 * **修改任何 prompt 都要 bump PROMPT_VERSION**（写入 llm_calls.prompt_version，便于复盘与回放）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROMPT_VERSION = 'v4'

export type PromptName =
  | 'curator.system'
  | 'taste_memo.user'
  | 'ideate.user'
  | 'ideate.mode.festival'
  | 'ideate.mode.single'
  | 'audit.system'
  | 'audit.user'
  | 'audit.mode.festival'
  | 'audit.mode.single'

const frozen = new Map<PromptName, string>()

function dir(): string {
  return process.env.PROMPTS_DIR ?? join(process.cwd(), 'src', 'curator', 'prompts')
}

export function prompt(name: PromptName): string {
  let text = frozen.get(name)
  if (text === undefined) {
    text = readFileSync(join(dir(), `${name}.md`), 'utf8').trim()
    frozen.set(name, text)
  }
  return text
}

/** `{{var}}` 替换；缺变量直接报错，避免把模板占位符发给模型。 */
export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`prompt variable {{${k}}} missing`)
    return String(vars[k])
  })
}
