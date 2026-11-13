/**
 * @fileoverview Count inputs — `limit`, `top_n`, `row_limit` — that bound how much a
 * tool returns. A value above the cap is served at the cap: the response reports the
 * requested and applied values, logs one line, and counts the call. With
 * `FAOSTAT_CLAMP_LIMITS=false`, `src/index.ts` registers each tool through
 * {@link withStrictCountInputs} instead, which advertises the cap as a schema
 * `maximum` and rejects a larger value at argument validation. Handlers clamp the
 * same way in both modes; the registered schema alone decides which one is live.
 * @module mcp-server/tools/count-input
 */

import { type AnyToolDefinition, type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';

/** `limit` → `Limit`, `top_n` → `TopN`, `row_limit` → `RowLimit`. */
type PascalCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Capitalize<Head>}${PascalCase<Tail>}`
  : Capitalize<S>;

/** Enrichment fields a clamped call fills: `requestedLimit` / `effectiveLimit` for `limit`. */
export type CountClampEnrichment<N extends string> = Record<
  `requested${PascalCase<N>}` | `effective${PascalCase<N>}`,
  z.ZodOptional<z.ZodNumber>
>;

/** A count input served by {@link CountInput.clamp}: `effective` is the value to use. */
export type CountClamp =
  | { clamped: false; effective: number }
  | {
      clamped: true;
      effective: number;
      requested: number;
      /** `limit 500 is above the 200 cap; returned up to 200.` — the tool appends its next call. */
      notice: string;
    };

/** One count input, built once per tool definition by {@link countInput}. */
export interface CountInput<N extends string> {
  /**
   * Serve `value` at the cap. At or below the cap the value passes through and
   * nothing is recorded. Above it, the call logs one line, increments the
   * `faostat.count_input.clamped` counter, and enriches the requested/effective
   * fields; the returned `notice` is the tool's to place first in its own notice,
   * since `ctx.enrich.notice` keeps only the last text written.
   */
  clamp(ctx: Context, value: number): CountClamp;
  /** Spread into the tool's `enrichment` block. */
  readonly enrichment: CountClampEnrichment<N>;
  /**
   * The input field's schema. Use it as-is: a chained `.describe()`, `.optional()`,
   * or `.default()` builds a new schema {@link withStrictCountInputs} cannot recognize.
   */
  readonly schema: z.ZodDefault<z.ZodNumber>;
}

/** What {@link withStrictCountInputs} needs to rebuild a count field with its cap as `maximum`. */
interface StrictSpec {
  cap: number;
  default: number;
  description: string;
}

/** Clamp-mode field schemas → their strict counterparts, keyed by schema instance. */
const strictSpecs = new WeakMap<object, StrictSpec>();

const clampedCalls = createCounter(
  'faostat.count_input.clamped',
  'Tool calls whose count input was above its cap and was served at the cap',
  '{call}',
);

/**
 * Build a count input. The clamp-mode schema advertises `type: "integer"`, the
 * minimum, and the default with no `maximum`: `z.number().int()` cannot carry that,
 * since it advertises and enforces `maximum: 9007199254740991`. Whole numbers are
 * checked by a refinement that runs only when no other check failed, so a value such
 * as `0.5` reports only its minimum, and float noise (`20.000000000000004`) fails
 * where a `multipleOf(1)` check would let it through.
 *
 * `description` receives the cap and states it as "at most N per call".
 */
export function countInput<const N extends string>(options: {
  cap: number;
  default: number;
  description: (cap: number) => string;
  name: N;
  tool: string;
}): CountInput<N> {
  const { cap, name, tool } = options;
  const description = options.description(cap);
  const schema = z
    .number()
    .min(1)
    .refine(Number.isInteger, {
      error: `Send a whole number, such as ${options.default}.`,
      when: (payload) => payload.issues.length === 0,
    })
    .meta({ type: 'integer' })
    .default(options.default)
    .describe(description);
  strictSpecs.set(schema, { cap, default: options.default, description });

  const suffix = name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const requestedKey = `requested${suffix}`;
  const effectiveKey = `effective${suffix}`;
  const enrichment = {
    [requestedKey]: z
      .number()
      .optional()
      .describe(`The ${name} the call asked for. Present only when it was above the ${cap} cap.`),
    [effectiveKey]: z
      .number()
      .optional()
      .describe(`The ${name} the call was served at. Present only when ${name} was capped.`),
  } as CountClampEnrichment<N>;

  return {
    schema,
    enrichment,
    clamp(ctx, value) {
      if (value <= cap) return { clamped: false, effective: value };
      // The request context already names the tool on every log line.
      ctx.log.info('Count input above its cap, served at the cap', {
        input: name,
        requested: value,
        cap,
      });
      clampedCalls.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'faostat.count_input': name });
      ctx.enrich({ [requestedKey]: value, [effectiveKey]: cap });
      return {
        clamped: true,
        effective: cap,
        requested: value,
        notice: `${name} ${value} is above the ${cap} cap; returned up to ${cap}.`,
      };
    },
  };
}

/**
 * The strict registration of a tool: every input field built by {@link countInput}
 * becomes `z.number().int().min(1).max(cap)` with its default and description, so
 * `tools/list` advertises the cap as `maximum` and a larger value is rejected before
 * the handler runs. A definition with no such field is returned unchanged.
 */
export function withStrictCountInputs(definition: AnyToolDefinition): AnyToolDefinition {
  const { input } = definition;
  if (!(input instanceof z.ZodObject)) return definition;
  const strict: Record<string, z.ZodDefault<z.ZodNumber>> = {};
  for (const [key, field] of Object.entries(input.shape)) {
    const spec = strictSpecs.get(field);
    if (spec) {
      strict[key] = z
        .number()
        .int()
        .min(1)
        .max(spec.cap)
        .default(spec.default)
        .describe(spec.description);
    }
  }
  if (Object.keys(strict).length === 0) return definition;
  return { ...definition, input: input.extend(strict) };
}
