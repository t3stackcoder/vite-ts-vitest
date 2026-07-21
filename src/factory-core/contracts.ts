import { z } from 'zod'
import type {
  FactoryAlias,
  FactoryKey,
  FactoryKeyValue,
  FactoryProductType,
  ModulePath,
} from './brand'
import { factoryKeySchema, factoryProductTypeSchema } from './brand'

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

/**
 * Compile-time screen for semantic versions. Template literals cannot express
 * everything the runtime regex enforces (integer-only segments — floats,
 * negatives, and extra dotted segments still decompose as `${number}`; the
 * prerelease/build character set; non-empty prerelease), so the eager parse
 * in defineFactoryFor and the module boundary schema remain authoritative.
 */
export type SemanticVersion =
  | `${number}.${number}.${number}`
  | `${number}.${number}.${number}-${string}`
  | `${number}.${number}.${number}+${string}`

export interface FactoryMetadata {
  readonly capabilities?: readonly string[]
  readonly description?: string
  readonly displayName: string
  readonly version: SemanticVersion
}

const semanticVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Shared between defineFactoryFor (eager, at authoring time) and the
 * registry's module boundary schema (at load time), so the two ends cannot
 * drift apart again.
 */
export const factoryMetadataSchema = z
  .strictObject({
    capabilities: z.array(z.string().trim().min(1)).readonly().optional(),
    description: z.string().optional(),
    displayName: z.string().trim().min(1),
    version: z.string().regex(semanticVersionPattern),
  })
  .readonly()

export interface AbstractFactory<
  out Key extends FactoryKey,
  out ProductType extends FactoryProductType,
  in Context,
  out Result,
> {
  readonly key: Key
  readonly metadata: FactoryMetadata
  readonly productType: ProductType
  /**
   * `this: void` states the runtime's actual contract: the registry rebinds
   * create to a synthetic frozen receiver, so an implementation may not rely
   * on its receiver. (Implicit `this` in a class method is invisible to this
   * screen; defineFactoryFor's delegation keeps such implementations working
   * regardless.)
   */
  create(
    this: void,
    context: Context,
    options?: FactoryCreateOptions,
  ): Awaitable<Result>
}

export interface FactoryContract<
  out ContextSchema extends z.ZodType = z.ZodType,
  out ResultSchema extends z.ZodType = z.ZodType,
  out ProductType extends FactoryProductType = FactoryProductType,
  out Discriminator extends string = string,
> {
  readonly contextSchema: ContextSchema
  readonly discriminator: Discriminator
  readonly productType: ProductType
  readonly resultSchema: ResultSchema
}

export type FactoryCatalog = Readonly<Record<string, FactoryContract>>

/**
 * Structural check rather than `instanceof z.ZodType`: when a consuming
 * application resolves a second copy of zod (version skew, failed dedupe),
 * its schemas are built from a different class identity and instanceof
 * would reject them at catalog definition time. Presence of the parse
 * surface the kernel actually invokes is the contract instead.
 */
const zodSchemaSchema = z.custom<z.ZodType>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return false
    }
    const candidate = value as Partial<
      Record<'parse' | 'safeParse' | 'safeParseAsync', unknown>
    >
    return (
      typeof candidate.parse === 'function' &&
      typeof candidate.safeParse === 'function' &&
      typeof candidate.safeParseAsync === 'function'
    )
  },
  { error: 'Expected a Zod schema.' },
)

const factoryContractDefinitionSchema = z.strictObject({
  contextSchema: zodSchemaSchema,
  discriminator: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
      error: 'Expected a JavaScript property identifier.',
    }),
  productType: factoryProductTypeSchema,
  resultSchema: zodSchemaSchema,
})

export function factoryContract<
  const ProductType extends FactoryProductType,
  const Discriminator extends string,
  const ContextSchema extends z.ZodType,
  const ResultSchema extends z.ZodType<
    Readonly<Record<NoInfer<Discriminator>, NoInfer<ProductType>>>,
    Readonly<Record<NoInfer<Discriminator>, NoInfer<ProductType>>>
  >,
>(definition: {
  readonly contextSchema: ContextSchema
  readonly discriminator: Discriminator
  readonly productType: ProductType
  readonly resultSchema: ResultSchema
}): FactoryContract<ContextSchema, ResultSchema, ProductType, Discriminator> {
  return Object.freeze(
    factoryContractDefinitionSchema.parse(definition),
  ) as FactoryContract<
    ContextSchema,
    ResultSchema,
    ProductType,
    Discriminator
  >
}

export function defineFactoryCatalog<const Catalog extends FactoryCatalog>(
  catalog: Catalog,
): Catalog {
  const validated: Record<string, FactoryContract> = {}

  for (const [key, contract] of Object.entries(catalog)) {
    factoryKeySchema.parse(key)
    validated[key] = Object.freeze(
      factoryContractDefinitionSchema.parse(contract),
    ) as FactoryContract
  }

  // The validated copies are adopted, not merely checked: strict parsing
  // rebuilds each contract from a single read of its properties, so a
  // hand-built contract (which the type permits) that is mutated — or backed
  // by getters — after definition cannot change the validation behavior the
  // registry re-reads on every create().
  return Object.freeze(validated) as Catalog
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

export type InferFactoryProductType<Contract> = Contract extends {
  readonly productType: infer ProductType extends FactoryProductType
}
  ? ProductType
  : never

export type InferFactoryDiscriminator<Contract> = Contract extends {
  readonly discriminator: infer Discriminator extends string
}
  ? Discriminator
  : never

export type FactoryCatalogEntry<
  Key extends FactoryKey,
  ContextSchema extends z.ZodType,
  ResultSchema extends z.ZodType,
  ProductType extends FactoryProductType,
  Discriminator extends string,
> = {
  readonly [Property in FactoryKeyValue<Key>]: FactoryContract<
    ContextSchema,
    ResultSchema,
    ProductType,
    Discriminator
  >
}

export function factoryCatalogEntry<
  Key extends FactoryKey,
  const ContextSchema extends z.ZodType,
  const ResultSchema extends z.ZodType,
  const ProductType extends FactoryProductType,
  const Discriminator extends string,
>(
  key: Key,
  contract: FactoryContract<
    ContextSchema,
    ResultSchema,
    ProductType,
    Discriminator
  >,
): FactoryCatalogEntry<
  Key,
  ContextSchema,
  ResultSchema,
  ProductType,
  Discriminator
> {
  return { [key]: contract } as FactoryCatalogEntry<
    Key,
    ContextSchema,
    ResultSchema,
    ProductType,
    Discriminator
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
  InferFactoryProductType<ContractAt<Catalog, Key>>,
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

/**
 * Attestation marker stamped by defineFactoryFor and required by the
 * registry's module boundary schema. Because defineFactoryFor contextually
 * types the implementation's create against the real catalog contract, the
 * marker is a machine-checkable attestation that the signature was
 * compile-time-verified — a bare `typeof create === 'function'` check cannot
 * recover that. Deliberately Symbol.for (forgeable): the boundary targets
 * accidental drift, not hostile modules, which already require a process
 * boundary.
 */
export const DEFINED_FACTORY = Symbol.for('factory-kernel/defined-factory')

export function defineFactoryFor<Catalog extends FactoryCatalog>() {
  return <Key extends FactoryCatalogKey<Catalog>>(key: Key) =>
    (
      implementation: Omit<FactoryFor<Catalog, Key>, 'key'>,
    ): FactoryFor<Catalog, Key> => {
      // Mirror factoryContract's eager parse: invalid metadata (bad semver,
      // blank display name) or an invalid product type throws where the
      // factory is written instead of at first load behind the module
      // boundary.
      factoryMetadataSchema.parse(implementation.metadata)
      factoryProductTypeSchema.parse(implementation.productType)

      // Delegate rather than spread: a spread copies own enumerable
      // properties only, silently dropping a prototype-held create (or
      // metadata/productType), and severs the implementation's receiver.
      const create: FactoryFor<Catalog, Key>['create'] = (context, options) =>
        implementation.create(context, options)

      return Object.freeze({
        [DEFINED_FACTORY]: true,
        create,
        key,
        metadata: implementation.metadata,
        productType: implementation.productType,
      })
    }
}
