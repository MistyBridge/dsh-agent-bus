/**
 * Tool-output schema gate for the agent-bus tool surface.
 *
 * Every tool's `execute` return must equal its declared `output.schema`
 * exactly — the harness rejects drift with a bare `ToolOutputError`, and the
 * `title` (v1.6) and `updatedAt` regressions showed that rejection is
 * unreadable enough to cost two silent core-tool failures. This module wraps
 * {@link defineTool} so the check runs inside `execute` with the harness's OWN
 * ruler (`validateJsonSchemaValue`, the same function the registry calls on
 * every successful value), and a mismatch becomes a structured error naming
 * the drifted field, the minimal return-vs-declaration diff, and the fix —
 * including a suggested declaration when the return carries a field the
 * schema does not.
 *
 * @module dsh-agent-bus/checked-tool
 */

import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type {
  DefineToolOptions,
  JsonSchemaNode,
  ParameterSchemaSpec,
  ToolDefinition,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

/** One key-level difference between a returned value and its declared schema. */
export interface OutputDiffEntry {
  /** JSON path into the returned value, e.g. `value[0].title`. */
  readonly path: string
  /** `added`: returned but not declared; `missing`: declared required but absent. */
  readonly kind: 'added' | 'missing'
  /** The field name at `path`. */
  readonly key: string
  /** The returned value's JSON type, present for `added` entries. */
  readonly type?: string
  /** Suggested `key: { ... }` declaration, present for `added` entries. */
  readonly suggestion?: string
}

/**
 * Thrown when an `execute` return value violates its declared `output.schema`.
 * Carries the same violations the harness would produce, the structured
 * minimal diff, and a message telling the model exactly which field drifted
 * and how to fix the declaration.
 */
export class ToolOutputMismatchError extends Error {
  /** Schema/value violations in validation order (the harness ruler's output). */
  readonly violations: readonly string[]
  /** Structured minimal diff between the return value and the schema. */
  readonly diff: readonly OutputDiffEntry[]

  constructor(toolName: string, violations: string[], diff: OutputDiffEntry[]) {
    super(buildMessage(toolName, violations, diff))
    this.name = 'ToolOutputMismatchError'
    this.violations = violations
    this.diff = diff
  }
}

/** JSON type name of one returned value, for diff diagnostics. */
function jsonTypeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Suggest a schema declaration for one returned value, inferred from its JSON
 * shape. The suggestion mirrors the codebase's closed-object style; the author
 * still picks the real type and requiredness. Returns `undefined` for values
 * that are not JSON (they fail the lossless boundary anyway, so no suggestion
 * is honest).
 */
function suggestSchema(value: unknown): JsonSchemaNode | undefined {
  if (value === null) return { type: 'null' }
  switch (typeof value) {
    case 'string':
      return { type: 'string' }
    case 'number':
      return { type: 'number' }
    case 'boolean':
      return { type: 'boolean' }
    case 'object': {
      if (Array.isArray(value)) {
        return value.length === 0
          ? { type: 'array' }
          : { type: 'array', items: suggestSchema(value[0]) ?? { type: 'string' } }
      }
      const properties: Record<string, JsonSchemaNode> = {}
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const suggested = suggestSchema(child)
        if (suggested !== undefined) properties[key] = suggested
      }
      return { type: 'object', additionalProperties: false, properties }
    }
    default:
      return undefined
  }
}

/** Whether a candidate is a plain object record (the only value shape schemas declare). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Walk one value against its schema, collecting key-level differences. */
function collectDiff(schema: JsonSchemaNode, value: unknown, path: string, out: OutputDiffEntry[]): void {
  if (schema.type === 'array') {
    if (schema.items === undefined || !Array.isArray(value) || value.length === 0) return
    collectDiff(schema.items, value[0], `${path}[0]`, out)
    return
  }
  if (schema.type !== 'object' || !isPlainRecord(value)) return
  const properties = schema.properties ?? {}
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) continue
      const added = value[key]
      const suggested = suggestSchema(added)
      out.push({
        path: `${path}.${key}`,
        kind: 'added',
        key,
        type: jsonTypeName(added),
        ...(suggested !== undefined ? { suggestion: `${key}: ${JSON.stringify(suggested)}` } : {}),
      })
    }
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      out.push({ path: `${path}.${key}`, kind: 'missing', key })
    }
  }
  for (const key of Object.keys(properties)) {
    const child = properties[key]
    if (child === undefined || !Object.hasOwn(value, key) || value[key] === undefined) continue
    collectDiff(child, value[key], `${path}.${key}`, out)
  }
}

/** Collect the minimal diff of one tool return value against its schema. */
function diffValueOf(schema: JsonSchemaNode, value: unknown): OutputDiffEntry[] {
  const out: OutputDiffEntry[] = []
  collectDiff(schema, value, 'value', out)
  return out
}

/** Render the readable mismatch message: field problems, minimal diff, fix. */
function buildMessage(toolName: string, violations: string[], diff: OutputDiffEntry[]): string {
  const lines = [
    `工具返回面与说明书不一致:tool "${toolName}" 的 execute 返回值未通过其声明的 output.schema 校验`,
  ]
  if (violations.length > 0) {
    lines.push('字段问题(与 harness 运行时同一把尺子 validateJsonSchemaValue):')
    for (const violation of violations) lines.push(`  - ${violation}`)
  }
  if (diff.length > 0) {
    lines.push('返回面与说明书的最小差异:')
    for (const entry of diff) {
      lines.push(entry.kind === 'added'
        ? `  - 新增字段 ${entry.path}(${entry.type ?? 'unknown'}):返回面携带、output.schema 未声明`
          + (entry.suggestion !== undefined ? ` → 建议声明 ${entry.suggestion}` : '')
        : `  - 缺失必填字段 ${entry.path}:output.schema 声明 required、返回面缺失`)
    }
  }
  lines.push('修复方向:')
  if (diff.some(entry => entry.kind === 'added')) {
    lines.push('  - 新增字段:同步更新 output.schema 的 properties,把建议声明并入(否则 harness 运行时仍会以 additionalProperties: false 拒绝)')
  }
  if (diff.some(entry => entry.kind === 'missing')) {
    lines.push('  - 缺失字段:让返回面携带该字段,或把该字段的 required 声明改为可选')
  }
  if (violations.some(v => !v.startsWith('missing required property') && !v.includes('is not a declared property'))) {
    lines.push('  - 类型不符:调整返回面的字段类型,使其与 output.schema 的声明一致(含非无损 JSON 值)')
  }
  return lines.join('\n')
}

/**
 * Define one agent-bus tool with the output-schema gate applied.
 *
 * The resolved `execute` value is checked against the compiled output schema
 * with the harness's own `validateJsonSchemaValue` before it is returned, so a
 * drift surfaces here as a {@link ToolOutputMismatchError} naming the field
 * and the fix — instead of the harness's bare `ToolOutputError` after the
 * fact.
 *
 * @param options - the same definition surface as {@link defineTool}.
 * @returns a registry-ready definition whose `execute` checks its own output.
 */
export function checkedTool<S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  // Explicit type arguments: passing the unresolved S/O back through
  // defineTool's own inference made the checker compare the recursive
  // InferArgs/InferValue conditionals against themselves (TS2321). The
  // wrapper never narrows these types further, so forwarding them verbatim
  // preserves the exact same definition surface.
  const def = defineTool<S, O>(options)
  return {
    ...def,
    async execute(args, exec) {
      const value = await def.execute(args, exec)
      const violations = validateJsonSchemaValue(def.output.schema, value, 'value')
      if (violations.length === 0) return value
      throw new ToolOutputMismatchError(def.name, violations, diffValueOf(def.output.schema, value))
    },
  }
}
