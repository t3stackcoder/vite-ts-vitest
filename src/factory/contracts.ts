import { z } from 'zod'
import type {
  FactoryAlias,
  FactoryKey,
  FactoryKeyValue,
  ModulePath,
} from './brand'
import { factoryKeySchema } from './brand'

export type Awaitable<Value> = Value | PromiseLike<Value>

export interface FactoryCreateOptions {
  readonly correlationId?: string
  readonly signal?: AbortSignal
  /**
   * Total creation budget. Inside a factory implementation this is the
   * overall budget, not the remaining time — treat the provided signal as
   * the authoritative deadline.
   */
  readonly timeoutMs?: number
}

export interface FactoryMetadata {
  readonly capabilities?: readonly string[]
  readonly description?: string
  readonly displayName: string
  readonly version: string
}

export interface AbstractFactory<
  out Key extends FactoryKey,
  in Context,
  out Result,
> {
  readonly key: Key
  readonly metadata: FactoryMetadata
  create(context: Context, options?: FactoryCreateOptions): Awaitable<Result>
}

export interface FactoryContract<
  out ContextSchema extends z.ZodType = z.ZodType,
  out ResultSchema extends z.ZodType = z.ZodType,
> {
  readonly contextSchema: ContextSchema
  readonly resultSchema: ResultSchema
}

export type FactoryCatalog = Readonly<Record<string, FactoryContract>>

const zodSchemaSchema = z.custom<z.ZodType>(
  (value) => value instanceof z.ZodType,
  { error: 'Expected a Zod schema.' },
)

const factoryContractDefinitionSchema = z.strictObject({
  contextSchema: zodSchemaSchema,
  resultSchema: zodSchemaSchema,
})

export function factoryContract<
  const ContextSchema extends z.ZodType,
  const ResultSchema extends z.ZodType,
>(
  contextSchema: ContextSchema,
  resultSchema: ResultSchema,
): FactoryContract<ContextSchema, ResultSchema> {
  return Object.freeze(
    factoryContractDefinitionSchema.parse({ contextSchema, resultSchema }),
  ) as FactoryContract<ContextSchema, ResultSchema>
}

export function defineFactoryCatalog<const Catalog extends FactoryCatalog>(
  catalog: Catalog,
): Catalog {
  for (const [key, contract] of Object.entries(catalog)) {
    factoryKeySchema.parse(key)
    factoryContractDefinitionSchema.parse(contract)
  }

  return Object.freeze(catalog)
}

export type InferFactoryInput<Contract> = Contract extends {
  readonly contextSchema: infer Schema extends z.ZodType
}
  ? z.input<Schema>
  : never

export type InferFactoryContext<Contract> = Contract extends {
  readonly contextSchema: infer Schema extends z.ZodType
}
  ? z.output<Schema>
  : never

export type InferFactoryRawResult<Contract> = Contract extends {
  readonly resultSchema: infer Schema extends z.ZodType
}
  ? z.input<Schema>
  : never

export type InferFactoryResult<Contract> = Contract extends {
  readonly resultSchema: infer Schema extends z.ZodType
}
  ? z.output<Schema>
  : never

export type FactoryCatalogEntry<
  Key extends FactoryKey,
  ContextSchema extends z.ZodType,
  ResultSchema extends z.ZodType,
> = {
  readonly [Property in FactoryKeyValue<Key>]: FactoryContract<
    ContextSchema,
    ResultSchema
  >
}

export function factoryCatalogEntry<
  Key extends FactoryKey,
  const ContextSchema extends z.ZodType,
  const ResultSchema extends z.ZodType,
>(
  key: Key,
  contract: FactoryContract<ContextSchema, ResultSchema>,
): FactoryCatalogEntry<Key, ContextSchema, ResultSchema> {
  return { [key]: contract } as FactoryCatalogEntry<
    Key,
    ContextSchema,
    ResultSchema
  >
}

export type FactoryCatalogKey<Catalog extends FactoryCatalog> = {
  [Key in keyof Catalog]-?: Key extends FactoryKey
    ? Key
    : Key extends string
      ? FactoryKey<Key>
      : never
}[keyof Catalog]

type ContractAt<
  Catalog extends FactoryCatalog,
  Key extends FactoryCatalogKey<Catalog>,
> = Catalog[FactoryKeyValue<Key> & keyof Catalog]

export type FactoryFor<
  Catalog extends FactoryCatalog,
  Key extends FactoryCatalogKey<Catalog>,
> = AbstractFactory<
  Key,
  InferFactoryContext<ContractAt<Catalog, Key>>,
  InferFactoryRawResult<ContractAt<Catalog, Key>>
>

type CatalogFactoryForKey<
  Catalog extends FactoryCatalog,
  Key extends FactoryCatalogKey<Catalog>,
> = Key extends FactoryCatalogKey<Catalog> ? FactoryFor<Catalog, Key> : never

export type CatalogFactory<Catalog extends FactoryCatalog> =
  CatalogFactoryForKey<Catalog, FactoryCatalogKey<Catalog>>

export interface FactoryModule<Factory> {
  readonly default: Factory
}

export type CatalogFactoryModule<Catalog extends FactoryCatalog> = FactoryModule<
  CatalogFactory<Catalog>
>

export interface FactorySource<
  Catalog extends FactoryCatalog,
  Key extends FactoryCatalogKey<Catalog> = FactoryCatalogKey<Catalog>,
> {
  readonly key: Key
  readonly load: () => Promise<CatalogFactoryModule<Catalog>>
  readonly modulePath: ModulePath
}

export type FactoryAliasMap<Catalog extends FactoryCatalog> = Readonly<
  Record<FactoryAlias, FactoryCatalogKey<Catalog>>
>

export type EmptyFactoryAliasMap = Readonly<Record<never, never>>

type FactoryAliasKey<Aliases extends object> = {
  [Key in keyof Aliases]-?: Key extends FactoryAlias
    ? Key
    : Key extends string
      ? FactoryAlias<Key>
      : never
}[keyof Aliases]

export type FactoryLookupKey<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog>,
> = FactoryCatalogKey<Catalog> | FactoryAliasKey<Aliases>

export type CanonicalFactoryKey<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog>,
  LookupKey extends FactoryLookupKey<Catalog, Aliases>,
> = LookupKey extends FactoryCatalogKey<Catalog>
  ? LookupKey
  : LookupKey extends FactoryAlias
    ? Extract<
        Aliases[LookupKey & keyof Aliases],
        FactoryCatalogKey<Catalog>
      >
    : never

type ContractForLookup<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog>,
  LookupKey extends FactoryLookupKey<Catalog, Aliases>,
> = CanonicalFactoryKey<Catalog, Aliases, LookupKey> extends infer Key extends
  FactoryCatalogKey<Catalog>
  ? ContractAt<Catalog, Key>
  : never

/** The value accepted by registry.create(), before the context schema parses it. */
export type FactoryContextForLookup<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog>,
  LookupKey extends FactoryLookupKey<Catalog, Aliases>,
> = InferFactoryInput<ContractForLookup<Catalog, Aliases, LookupKey>>

/** The validated context supplied to a factory implementation. */
export type FactoryValidatedContextForLookup<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog>,
  LookupKey extends FactoryLookupKey<Catalog, Aliases>,
> = InferFactoryContext<ContractForLookup<Catalog, Aliases, LookupKey>>

/** The unparsed product returned by a factory implementation. */
export type FactoryRawResultForLookup<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog>,
  LookupKey extends FactoryLookupKey<Catalog, Aliases>,
> = InferFactoryRawResult<ContractForLookup<Catalog, Aliases, LookupKey>>

/** The validated product returned by registry.create(). */
export type FactoryResultForLookup<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog>,
  LookupKey extends FactoryLookupKey<Catalog, Aliases>,
> = InferFactoryResult<ContractForLookup<Catalog, Aliases, LookupKey>>

export type FactoryForLookup<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog>,
  LookupKey extends FactoryLookupKey<Catalog, Aliases>,
> = CanonicalFactoryKey<Catalog, Aliases, LookupKey> extends infer Key extends
  FactoryCatalogKey<Catalog>
  ? FactoryFor<Catalog, Key>
  : never

export function defineFactoryFor<Catalog extends FactoryCatalog>() {
  return <Key extends FactoryCatalogKey<Catalog>>(key: Key) =>
    (
      implementation: Omit<FactoryFor<Catalog, Key>, 'key'>,
    ): FactoryFor<Catalog, Key> =>
      Object.freeze({ key, ...implementation })
}
