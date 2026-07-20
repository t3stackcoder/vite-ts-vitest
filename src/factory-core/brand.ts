import { z } from 'zod'

declare const brandToken: unique symbol

export type Brand<Value, Name extends string> = Value & {
  readonly [brandToken]: {
    readonly name: Name
    readonly value: Value
  }
}

export type FactoryKey<Value extends string = string> = Brand<
  Value,
  'FactoryKey'
>

export type FactoryAlias<Value extends string = string> = Brand<
  Value,
  'FactoryAlias'
>

/**
 * A domain-defined product discriminator. Unlike registry keys, product types
 * remain plain string literals so TypeScript can use them naturally in
 * discriminated unions.
 */
export type FactoryProductType<Value extends string = string> = Value

export type ModulePath = Brand<string, 'ModulePath'>

export type FactoryKeyValue<Key extends FactoryKey> = Key[typeof brandToken][
  'value'
]

const FACTORY_SEGMENT_SOURCE = '[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*'
const FACTORY_SEGMENT_PATTERN = new RegExp(`^${FACTORY_SEGMENT_SOURCE}$`)
const FACTORY_LOOKUP_PATTERN = new RegExp(
  `^${FACTORY_SEGMENT_SOURCE}:${FACTORY_SEGMENT_SOURCE}$`,
)

const factorySegmentSchema = z.string().regex(FACTORY_SEGMENT_PATTERN, {
  error: 'Expected a lowercase kebab-case segment without a colon.',
})

export const factoryProductTypeSchema = factorySegmentSchema

const factoryLookupValueSchema = z
  .string()
  .regex(FACTORY_LOOKUP_PATTERN, {
    error:
      'Expected "namespace:name" with lowercase kebab-case segments.',
  })

export const factoryKeySchema = factoryLookupValueSchema.transform(
  (value) => value as FactoryKey,
)

export const factoryAliasSchema = factoryLookupValueSchema.transform(
  (value) => value as FactoryAlias,
)

export const modulePathSchema = z
  .string()
  .refine((value) => value.length > 0 && value === value.trim(), {
    error:
      'Module path cannot be empty or padded with leading/trailing whitespace.',
  })
  .transform((value) => value as ModulePath)

/**
 * The compile-time shape of factory keys and aliases: "namespace:name".
 * A template literal cannot express the full kebab-case rule — the Zod
 * pattern above remains authoritative — but the colon requirement catches
 * the common typo in the editor instead of at startup.
 */
export type FactoryLookupLiteral = `${string}:${string}`

export function factoryKey<const Value extends FactoryLookupLiteral>(
  value: Value,
): FactoryKey<Value> {
  return factoryKeySchema.parse(value) as FactoryKey<Value>
}

export function factoryAlias<const Value extends FactoryLookupLiteral>(
  value: Value,
): FactoryAlias<Value> {
  return factoryAliasSchema.parse(value) as FactoryAlias<Value>
}

export function isFactoryKey(value: unknown): value is FactoryKey {
  return factoryKeySchema.safeParse(value).success
}

export function isFactoryAlias(value: unknown): value is FactoryAlias {
  return factoryAliasSchema.safeParse(value).success
}

export function modulePath(value: string): ModulePath {
  return modulePathSchema.parse(value)
}

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

/**
 * Compile-time screen for a single key segment. Not the full kebab-case
 * grammar — the Zod segment pattern stays authoritative — but it rejects the
 * mistakes people actually type (uppercase, spaces, colons, underscores,
 * empty or separator-edged segments, leading digits) in the editor. An
 * invalid literal collapses the parameter to `never`, which reads as
 * "argument not assignable to never" at the call site.
 */
export type FactoryKeySegment<Value extends string> = Value extends ''
  ? never
  : Value extends
        | `${string}:${string}`
        | `${string} ${string}`
        | `${string}_${string}`
        | `-${string}`
        | `.${string}`
        | `${string}-`
        | `${string}.`
        | `${Digit}${string}`
    ? never
    : Lowercase<Value> extends Value
      ? Value
      : never

export interface FactoryNamespace<Namespace extends string> {
  alias<const Name extends string>(
    name: Name & FactoryKeySegment<Name>,
  ): FactoryAlias<`${Namespace}:${Name}`>
  key<const Name extends string>(
    name: Name & FactoryKeySegment<Name>,
  ): FactoryKey<`${Namespace}:${Name}`>
  readonly namespace: Namespace
}

/**
 * Builds keys and aliases from known parts so the "namespace:name" format is
 * composed by the type system instead of typed by hand. The namespace is
 * written once and validated eagerly; the colon can never be mistyped
 * because it is never typed. `aircraft.key('passenger')` infers
 * `FactoryKey<'aircraft:passenger'>` exactly.
 */
export function factoryNamespace<const Namespace extends string>(
  namespace: Namespace & FactoryKeySegment<Namespace>,
): FactoryNamespace<Namespace> {
  factorySegmentSchema.parse(namespace)

  return Object.freeze({
    alias<const Name extends string>(name: Name & FactoryKeySegment<Name>) {
      return factoryAlias(`${namespace}:${name}`)
    },
    key<const Name extends string>(name: Name & FactoryKeySegment<Name>) {
      return factoryKey(`${namespace}:${name}`)
    },
    namespace,
  })
}

export type FactoryKeySet<Namespace extends string, Name extends string> = {
  readonly [Segment in Name]: FactoryKey<`${Namespace}:${Segment}`>
}

export type FactoryAliasSet<Namespace extends string, Name extends string> = {
  readonly [Segment in Name]: FactoryAlias<`${Namespace}:${Segment}`>
}

export type FactoryProductTypeSet<Name extends string> = {
  readonly [Segment in Name]: FactoryProductType<Segment>
}

type ScreenedSegments<Names extends readonly string[]> = {
  readonly [Index in keyof Names]: FactoryKeySegment<Names[Index] & string>
}

/**
 * Declares a namespace's key vocabulary exactly once and derives everything
 * from it: the branded key values become properties, and the union type
 * comes from the same tuple. Types are erased at runtime, so derivation can
 * only flow value → type — this is the closest inversion available, and it
 * makes every usage site compiler-checked: `aircraft.passenger2` is a
 * property-access error unless 'passenger2' was declared.
 */
export function factoryKeySet<
  const Namespace extends string,
  const Names extends readonly string[],
>(
  namespace: Namespace & FactoryKeySegment<Namespace>,
  names: Names & ScreenedSegments<Names>,
): FactoryKeySet<Namespace, Names[number]> {
  const record: Record<string, FactoryKey> = {}

  for (const name of names) {
    if (Object.hasOwn(record, name)) {
      throw new TypeError(
        `Duplicate name "${name}" in the "${namespace}" key set.`,
      )
    }
    record[name] = factoryKey(`${namespace}:${name}`)
  }

  return Object.freeze(record) as FactoryKeySet<Namespace, Names[number]>
}

/** Defines one product discriminator beside the factory that produces it. */
export function factoryProductType<const Value extends string>(
  value: Value & FactoryKeySegment<Value>,
): FactoryProductType<Value> {
  return factoryProductTypeSchema.parse(value) as FactoryProductType<Value>
}

/** Builds the design-time property set generated from factory declarations. */
export function factoryProductTypeSet<const Names extends readonly string[]>(
  names: Names & ScreenedSegments<Names>,
): FactoryProductTypeSet<Names[number]> {
  const record: Record<string, FactoryProductType> = {}

  for (const name of names) {
    if (Object.hasOwn(record, name)) {
      throw new TypeError(`Duplicate product type "${name}".`)
    }

    record[name] = factoryProductType(name)
  }

  return Object.freeze(record) as FactoryProductTypeSet<Names[number]>
}

/** The alias counterpart of factoryKeySet: one declared vocabulary, branded alias values as properties. */
export function factoryAliasSet<
  const Namespace extends string,
  const Names extends readonly string[],
>(
  namespace: Namespace & FactoryKeySegment<Namespace>,
  names: Names & ScreenedSegments<Names>,
): FactoryAliasSet<Namespace, Names[number]> {
  const record: Record<string, FactoryAlias> = {}

  for (const name of names) {
    if (Object.hasOwn(record, name)) {
      throw new TypeError(
        `Duplicate name "${name}" in the "${namespace}" alias set.`,
      )
    }
    record[name] = factoryAlias(`${namespace}:${name}`)
  }

  return Object.freeze(record) as FactoryAliasSet<Namespace, Names[number]>
}
