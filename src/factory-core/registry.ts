import { z } from 'zod'
import {
  factoryKeySchema,
  factoryProductTypeSchema,
  isFactoryAlias,
  isFactoryKey,
  modulePathSchema,
  type FactoryAlias,
  type FactoryKey,
  type ModulePath,
} from './brand'
import { DEFINED_FACTORY, factoryMetadataSchema } from './contracts'
import type {
  Awaitable,
  CanonicalFactoryKey,
  CatalogFactory,
  CatalogFactoryModule,
  EmptyFactoryAliasMap,
  FactoryAliasMap,
  FactoryCatalog,
  FactoryCatalogKey,
  FactoryContextForLookup,
  FactoryContract,
  FactoryCreateOptions,
  FactoryLookupKey,
  FactoryRawResultForLookup,
  FactoryResultForLookup,
  FactorySource,
  FactoryValidatedContextForLookup,
} from './contracts'
import {
  FactoryRegistryError,
  isFactoryRegistryError,
  normalizeFactoryRegistryError,
  type FactoryRegistryErrorCode,
} from './errors'

const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3
const DEFAULT_CIRCUIT_RESET_TIMEOUT_MS = 30_000
const DEFAULT_CREATION_TIMEOUT_MS = 30_000
const DEFAULT_LOAD_TIMEOUT_MS = 15_000
const DEFAULT_MAX_CONCURRENT_CREATIONS = 16

export type FactoryLoadStatus = 'failed' | 'idle' | 'loading' | 'ready'
export type FactoryCircuitStatus = 'closed' | 'half-open' | 'open'

export interface FactoryCircuitSnapshot {
  readonly consecutiveFailures: number
  readonly status: FactoryCircuitStatus
}

export interface FactoryRegistrationSnapshot<
  Key extends FactoryKey = FactoryKey,
> {
  readonly activeCreations: number
  readonly aliases: readonly FactoryAlias[]
  readonly circuit: FactoryCircuitSnapshot
  readonly errorCode?: FactoryRegistryErrorCode
  readonly key: Key
  readonly modulePath: ModulePath
  readonly status: FactoryLoadStatus
}

export interface FactoryRegistrySnapshot<Key extends FactoryKey = FactoryKey> {
  readonly factories: readonly FactoryRegistrationSnapshot<Key>[]
}

export interface FactoryPreloadFailure<Key extends FactoryKey = FactoryKey> {
  readonly error: FactoryRegistryError
  readonly key: Key
}

export interface FactoryPreloadReport<Key extends FactoryKey = FactoryKey> {
  readonly failed: readonly FactoryPreloadFailure<Key>[]
  readonly loaded: readonly Key[]
}

export type FactoryAttempt<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly error: FactoryRegistryError; readonly ok: false }

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number
  readonly resetTimeoutMs?: number
}

/**
 * Operational transitions pushed to the registry's onEvent listener. Events
 * cover factory health (loads, circuit and bulkhead activity, creation
 * outcomes) rather than caller input errors, which are reported only to the
 * offending caller. correlationId is present when the triggering request
 * supplied one.
 */
export type FactoryRegistryEvent<Key extends FactoryKey = FactoryKey> =
  | { readonly key: Key; readonly type: 'circuit-closed' }
  | {
      readonly consecutiveFailures: number
      readonly key: Key
      readonly type: 'circuit-opened'
    }
  | { readonly key: Key; readonly type: 'circuit-probed' }
  | { readonly key: Key; readonly type: 'circuit-re-armed' }
  | { readonly key: Key; readonly type: 'circuit-reset' }
  | { readonly key: Key; readonly type: 'concurrency-reset' }
  | {
      readonly code: FactoryRegistryErrorCode
      readonly correlationId?: string
      readonly key: Key
      readonly type: 'creation-failed'
    }
  | {
      readonly correlationId?: string
      readonly key: Key
      readonly type: 'creation-succeeded'
    }
  | { readonly key: Key; readonly type: 'factory-invalidated' }
  | {
      readonly code: FactoryRegistryErrorCode
      readonly key: Key
      readonly type: 'factory-load-failed'
    }
  | { readonly key: Key; readonly type: 'factory-loaded' }

export type FactoryRegistryEventListener<Key extends FactoryKey = FactoryKey> =
  (event: FactoryRegistryEvent<Key>) => void

/**
 * Per-factory overrides for the registry-wide execution policy. Anything
 * omitted falls back to the registry default.
 */
export interface FactoryPolicyOverrides {
  readonly circuitBreaker?: CircuitBreakerOptions
  readonly creationTimeoutMs?: number
  readonly maxConcurrentCreations?: number
}

export type FactoryPolicyMap<Catalog extends FactoryCatalog> = Readonly<
  Partial<Record<FactoryCatalogKey<Catalog>, FactoryPolicyOverrides>>
>

export interface SmartFactoryRegistryOptions<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog> = EmptyFactoryAliasMap,
> {
  readonly aliases?: Aliases
  readonly cacheFailures?: boolean
  readonly catalog: Catalog
  readonly circuitBreaker?: CircuitBreakerOptions
  readonly creationTimeoutMs?: number
  readonly loadTimeoutMs?: number
  readonly maxConcurrentCreations?: number
  readonly onEvent?: FactoryRegistryEventListener<FactoryCatalogKey<Catalog>>
  readonly policies?: FactoryPolicyMap<Catalog>
  readonly sources: readonly FactorySource<Catalog>[]
}

interface RuntimeSource<Catalog extends FactoryCatalog> {
  readonly key: FactoryKey
  readonly load: () => Promise<CatalogFactoryModule<Catalog>>
  readonly modulePath: ModulePath
}

type EntryState<Catalog extends FactoryCatalog> =
  | { readonly status: 'idle' }
  | {
      readonly promise: Promise<CatalogFactory<Catalog>>
      readonly status: 'loading'
    }
  | { readonly factory: CatalogFactory<Catalog>; readonly status: 'ready' }
  | { readonly error: FactoryRegistryError; readonly status: 'failed' }

type CircuitState =
  | {
      readonly consecutiveFailures: number
      readonly generation: number
      readonly status: 'closed'
    }
  | {
      readonly consecutiveFailures: number
      readonly generation: number
      readonly openedAt: number
      readonly status: 'open'
    }
  | {
      readonly consecutiveFailures: number
      readonly generation: number
      readonly openedAt: number
      readonly probeToken: symbol
      readonly status: 'half-open'
    }

type CircuitPermit =
  | { readonly generation: number; readonly kind: 'closed' }
  | {
      readonly generation: number
      readonly kind: 'half-open'
      readonly probeToken: symbol
    }

interface FactoryEntryPolicy {
  readonly circuitFailureThreshold: number
  readonly circuitResetTimeoutMs: number
  readonly creationTimeoutMs: number
  readonly maxConcurrentCreations: number
}

interface RegistryEntry<Catalog extends FactoryCatalog> {
  activeCreations: number
  circuit: CircuitState
  readonly policy: FactoryEntryPolicy
  revision: number
  readonly source: RuntimeSource<Catalog>
  state: EntryState<Catalog>
}

const boundedDurationSchema = z.number().int().positive().max(3_600_000)
const failureThresholdSchema = z.number().int().positive().max(1_000)
const concurrencyLimitSchema = z.number().int().positive().max(10_000)
const abortSignalSchema = z.custom<AbortSignal>(
  (value) =>
    typeof AbortSignal !== 'undefined' && value instanceof AbortSignal,
  { error: 'Expected an AbortSignal.' },
)
const factoryCreateOptionsSchema = z
  .strictObject({
    correlationId: z.string().trim().min(1).max(256).optional(),
    signal: abortSignalSchema.optional(),
    timeoutMs: boundedDurationSchema.optional(),
  })
  .readonly()

const factoryPolicyOverridesSchema = z.strictObject({
  circuitBreaker: z
    .strictObject({
      failureThreshold: failureThresholdSchema.optional(),
      resetTimeoutMs: boundedDurationSchema.optional(),
    })
    .optional(),
  creationTimeoutMs: boundedDurationSchema.optional(),
  maxConcurrentCreations: concurrencyLimitSchema.optional(),
})

const factoryCreateFunctionSchema = z.custom<CallableFunction>(
  (value) => typeof value === 'function',
  { error: 'Expected a factory create function.' },
)

/**
 * The attestation check runs against the raw default export, piped in front
 * of the object schema: Zod's object parsing rebuilds the value with its
 * string keys only, so a refinement placed after it would never see the
 * symbol-keyed marker.
 */
const definedFactorySchema = z
  .custom<Record<string, unknown>>(
    (value) => typeof value === 'object' && value !== null,
    { error: 'Expected a factory module default export object.' },
  )
  .refine((factory) => Reflect.get(factory, DEFINED_FACTORY) === true, {
    error: 'Factory modules must be built with defineFactoryFor.',
  })

const factoryModuleBoundarySchema = z.looseObject({
  default: definedFactorySchema.pipe(
    z.looseObject({
      create: factoryCreateFunctionSchema,
      key: factoryKeySchema,
      metadata: factoryMetadataSchema,
      productType: factoryProductTypeSchema,
    }),
  ),
})

function closedCircuit(generation = 0): CircuitState {
  return {
    consecutiveFailures: 0,
    generation,
    status: 'closed',
  }
}

export class SmartFactoryRegistry<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog> = EmptyFactoryAliasMap,
> {
  readonly #aliasTargets = new Map<string, FactoryKey>()
  readonly #cacheFailures: boolean
  readonly #catalog: Catalog
  readonly #circuitFailureThreshold: number
  readonly #circuitResetTimeoutMs: number
  readonly #creationTimeoutMs: number
  readonly #entries = new Map<string, RegistryEntry<Catalog>>()
  readonly #loadTimeoutMs: number
  readonly #maxConcurrentCreations: number
  readonly #onEvent:
    | FactoryRegistryEventListener<FactoryCatalogKey<Catalog>>
    | undefined
  readonly #policyOverrides = new Map<string, FactoryPolicyOverrides>()

  constructor(options: SmartFactoryRegistryOptions<Catalog, Aliases>) {
    this.#cacheFailures = options.cacheFailures ?? true
    this.#catalog = options.catalog
    this.#creationTimeoutMs = boundedDurationSchema.parse(
      options.creationTimeoutMs ?? DEFAULT_CREATION_TIMEOUT_MS,
    )
    this.#loadTimeoutMs = boundedDurationSchema.parse(
      options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
    )
    this.#maxConcurrentCreations = concurrencyLimitSchema.parse(
      options.maxConcurrentCreations ?? DEFAULT_MAX_CONCURRENT_CREATIONS,
    )
    this.#circuitFailureThreshold = failureThresholdSchema.parse(
      options.circuitBreaker?.failureThreshold ??
        DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
    )
    this.#circuitResetTimeoutMs = boundedDurationSchema.parse(
      options.circuitBreaker?.resetTimeoutMs ??
        DEFAULT_CIRCUIT_RESET_TIMEOUT_MS,
    )
    this.#onEvent = options.onEvent

    if (options.policies !== undefined) {
      this.#registerPolicies(options.policies)
    }

    this.register(options.sources)

    if (options.aliases !== undefined) {
      this.#registerAliases(options.aliases)
    }
  }

  register(sources: readonly FactorySource<Catalog>[]): void {
    const pending = new Map<string, RuntimeSource<Catalog>>()
    const occupiedPaths = new Set(
      [...this.#entries.values()].map((entry) => entry.source.modulePath),
    )

    for (const source of sources) {
      if (
        !isFactoryKey(source.key) ||
        !modulePathSchema.safeParse(source.modulePath).success ||
        typeof source.load !== 'function'
      ) {
        throw new FactoryRegistryError(
          'INVALID_SOURCE',
          'A factory source contains an invalid key, module path, or loader.',
        )
      }

      if (!Object.hasOwn(this.#catalog, source.key)) {
        throw new FactoryRegistryError(
          'INVALID_SOURCE',
          `Factory key "${source.key}" has no schema contract in the catalog.`,
          { details: { key: source.key, modulePath: source.modulePath } },
        )
      }

      if (this.#entries.has(source.key) || pending.has(source.key)) {
        throw new FactoryRegistryError(
          'DUPLICATE_FACTORY',
          `Factory key "${source.key}" is already registered.`,
          { details: { key: source.key, modulePath: source.modulePath } },
        )
      }

      if (this.#aliasTargets.has(source.key)) {
        throw new FactoryRegistryError(
          'ALIAS_COLLISION',
          `Factory key "${source.key}" collides with an existing alias.`,
          { details: { key: source.key } },
        )
      }

      if (occupiedPaths.has(source.modulePath)) {
        throw new FactoryRegistryError(
          'INVALID_SOURCE',
          `Module path "${source.modulePath}" is already registered.`,
          { details: { key: source.key, modulePath: source.modulePath } },
        )
      }

      const runtimeSource: RuntimeSource<Catalog> = Object.freeze({
        key: source.key,
        load: source.load,
        modulePath: source.modulePath,
      })

      pending.set(source.key, runtimeSource)
      occupiedPaths.add(source.modulePath)
    }

    for (const [key, source] of pending) {
      this.#entries.set(key, {
        activeCreations: 0,
        circuit: closedCircuit(),
        policy: this.#entryPolicy(key),
        revision: 0,
        source,
        state: { status: 'idle' },
      })
    }
  }

  has(key: FactoryKey | FactoryAlias): boolean {
    return this.#entries.has(key) || this.#aliasTargets.has(key)
  }

  keys(): readonly FactoryCatalogKey<Catalog>[] {
    return Object.freeze(
      [...this.#entries.keys()] as FactoryCatalogKey<Catalog>[],
    )
  }

  lookupKeys(): readonly FactoryLookupKey<Catalog, Aliases>[] {
    return Object.freeze([
      ...this.#entries.keys(),
      ...this.#aliasTargets.keys(),
    ] as FactoryLookupKey<Catalog, Aliases>[])
  }

  canonicalKey<Key extends FactoryLookupKey<Catalog, Aliases>>(
    key: Key,
  ): CanonicalFactoryKey<Catalog, Aliases, Key> {
    return this.#resolveCanonicalKey(key) as CanonicalFactoryKey<
      Catalog,
      Aliases,
      Key
    >
  }

  async create<Key extends FactoryLookupKey<Catalog, Aliases>>(
    key: Key,
    context: FactoryContextForLookup<Catalog, Aliases, Key>,
    options: FactoryCreateOptions = {},
  ): Promise<FactoryResultForLookup<Catalog, Aliases, Key>> {
    const executionOptions = this.#executionOptions(options, key)
    this.#assertNotAborted(key, executionOptions.signal)
    const canonicalKey = this.#resolveCanonicalKey(key)
    const entry = this.#requiredEntry(canonicalKey)
    const executionTimeoutMs =
      executionOptions.timeoutMs ?? entry.policy.creationTimeoutMs
    const contract = this.#requiredContract(canonicalKey)
    const contextResult = await contract.contextSchema.safeParseAsync(context)

    if (!contextResult.success) {
      throw new FactoryRegistryError(
        'INVALID_FACTORY_CONTEXT',
        `Context validation failed for factory "${canonicalKey}".`,
        {
          cause: contextResult.error,
          details: { issues: contextResult.error.issues, key: canonicalKey },
        },
      )
    }

    this.#assertNotAborted(key, executionOptions.signal)
    const factory = await this.#awaitWithAbort(
      this.#loadFactory(canonicalKey),
      key,
      executionOptions.signal,
    )
    this.#assertNotAborted(key, executionOptions.signal)
    const releaseSlot = this.#acquireExecutionSlot(
      entry,
      canonicalKey,
      executionOptions.correlationId,
    )

    let circuitPermit: CircuitPermit
    try {
      circuitPermit = this.#acquireCircuitPermit(
        entry,
        canonicalKey,
        executionOptions.correlationId,
      )
    } catch (error) {
      releaseSlot()
      throw error
    }

    const create = factory.create as (
      context: FactoryValidatedContextForLookup<Catalog, Aliases, Key>,
      options?: FactoryCreateOptions,
    ) => Awaitable<FactoryRawResultForLookup<Catalog, Aliases, Key>>

    try {
      const validatedResult = await this.#runWithExecutionControls(
        key,
        executionTimeoutMs,
        executionOptions,
        releaseSlot,
        async (effectiveOptions) => {
          const rawResult = await create.call(
            factory,
            contextResult.data as FactoryValidatedContextForLookup<
              Catalog,
              Aliases,
              Key
            >,
            effectiveOptions,
          )
          const result = await contract.resultSchema.safeParseAsync(rawResult)

          if (!result.success) {
            throw new FactoryRegistryError(
              'INVALID_FACTORY_RESULT',
              `Result validation failed for factory "${canonicalKey}".`,
              {
                cause: result.error,
                details: {
                  issues: result.error.issues,
                  key: canonicalKey,
                },
              },
            )
          }

          const parsedResult = result.data
          const hasExpectedProductType =
            typeof parsedResult === 'object' &&
            parsedResult !== null &&
            Object.hasOwn(parsedResult, contract.discriminator) &&
            Reflect.get(parsedResult, contract.discriminator) ===
              contract.productType

          if (!hasExpectedProductType) {
            const actualProductType =
              typeof parsedResult === 'object' && parsedResult !== null
                ? Reflect.get(parsedResult, contract.discriminator)
                : undefined

            throw new FactoryRegistryError(
              'INVALID_FACTORY_RESULT',
              `Factory "${canonicalKey}" returned a result whose "${contract.discriminator}" discriminator did not match "${contract.productType}".`,
              {
                details: {
                  actualProductType,
                  discriminator: contract.discriminator,
                  expectedProductType: contract.productType,
                  key: canonicalKey,
                },
              },
            )
          }

          return parsedResult as FactoryResultForLookup<
            Catalog,
            Aliases,
            Key
          >
        },
      )

      this.#recordCircuitSuccess(entry, circuitPermit)
      this.#emit({
        ...(executionOptions.correlationId === undefined
          ? {}
          : { correlationId: executionOptions.correlationId }),
        key: canonicalKey,
        type: 'creation-succeeded',
      })
      return validatedResult
    } catch (cause) {
      const error = this.#normalizeExecutionError(cause, canonicalKey)
      if (this.#countsTowardCircuit(error)) {
        this.#recordCircuitFailure(entry, circuitPermit)
      } else {
        this.#releaseCircuitProbe(entry, circuitPermit)
      }
      this.#emit({
        ...(executionOptions.correlationId === undefined
          ? {}
          : { correlationId: executionOptions.correlationId }),
        code: error.code,
        key: canonicalKey,
        type: 'creation-failed',
      })
      throw error
    }
  }

  async tryCreate<Key extends FactoryLookupKey<Catalog, Aliases>>(
    key: Key,
    context: FactoryContextForLookup<Catalog, Aliases, Key>,
    options: FactoryCreateOptions = {},
  ): Promise<FactoryAttempt<FactoryResultForLookup<Catalog, Aliases, Key>>> {
    try {
      return { ok: true, value: await this.create(key, context, options) }
    } catch (error) {
      return {
        error: normalizeFactoryRegistryError(error),
        ok: false,
      }
    }
  }

  /**
   * Discards the cached module (or cached load failure) so the next use
   * reloads it. Deliberately leaves the circuit breaker and concurrency
   * counter untouched; pair with resetCircuit()/resetConcurrency() when a
   * full operator reset is intended.
   */
  invalidate(key: FactoryKey | FactoryAlias): void {
    const canonicalKey = this.#resolveCanonicalKey(key)
    const entry = this.#requiredEntry(canonicalKey)
    entry.revision += 1
    entry.state = { status: 'idle' }
    this.#emit({ key: canonicalKey, type: 'factory-invalidated' })
  }

  /**
   * Operator reset for the circuit breaker only. A cached load failure is a
   * separate concern; clear it with invalidate().
   */
  resetCircuit(key: FactoryKey | FactoryAlias): void {
    const canonicalKey = this.#resolveCanonicalKey(key)
    const entry = this.#requiredEntry(canonicalKey)
    entry.circuit = closedCircuit(entry.circuit.generation + 1)
    this.#emit({ key: canonicalKey, type: 'circuit-reset' })
  }

  /**
   * Operator reset for the concurrency bulkhead. Timed-out work keeps its
   * slot until the underlying promise settles, so a factory that hangs
   * forever can permanently exhaust its slots; this reclaims them. Slots
   * belonging to still-running work are also forgotten, so only use this
   * once the factory's outstanding work is known to be abandoned.
   */
  resetConcurrency(key: FactoryKey | FactoryAlias): void {
    const canonicalKey = this.#resolveCanonicalKey(key)
    const entry = this.#requiredEntry(canonicalKey)
    entry.activeCreations = 0
    this.#emit({ key: canonicalKey, type: 'concurrency-reset' })
  }

  async preload(
    keys: readonly (FactoryKey | FactoryAlias)[] = this.keys(),
  ): Promise<FactoryPreloadReport<FactoryCatalogKey<Catalog>>> {
    const uniqueKeys = new Map<string, FactoryCatalogKey<Catalog>>()

    for (const lookupKey of keys) {
      const canonicalKey = this.#resolveCanonicalKey(lookupKey)
      uniqueKeys.set(
        canonicalKey,
        canonicalKey as FactoryCatalogKey<Catalog>,
      )
    }

    const loaded: FactoryCatalogKey<Catalog>[] = []
    const failed: FactoryPreloadFailure<FactoryCatalogKey<Catalog>>[] = []

    await Promise.all(
      [...uniqueKeys.values()].map(async (key) => {
        try {
          await this.#loadFactory(key)
          loaded.push(key)
        } catch (error) {
          failed.push({
            error: normalizeFactoryRegistryError(error),
            key,
          })
        }
      }),
    )

    loaded.sort((left, right) => left.localeCompare(right))
    failed.sort((left, right) => left.key.localeCompare(right.key))

    return Object.freeze({
      failed: Object.freeze(failed),
      loaded: Object.freeze(loaded),
    })
  }

  snapshot(): FactoryRegistrySnapshot<FactoryCatalogKey<Catalog>> {
    const factories = [...this.#entries.values()].map((entry) => {
      const aliases = [...this.#aliasTargets.entries()]
        .filter(([, target]) => target === entry.source.key)
        .map(([alias]) => alias as FactoryAlias)
        .sort((left, right) => left.localeCompare(right))
      const errorCode =
        entry.state.status === 'failed' ? entry.state.error.code : undefined

      return Object.freeze({
        activeCreations: entry.activeCreations,
        aliases: Object.freeze(aliases),
        circuit: Object.freeze({
          consecutiveFailures: entry.circuit.consecutiveFailures,
          status: entry.circuit.status,
        }),
        ...(errorCode === undefined ? {} : { errorCode }),
        key: entry.source.key,
        modulePath: entry.source.modulePath,
        status: entry.state.status,
      })
    })

    factories.sort((left, right) => left.key.localeCompare(right.key))
    // Registered keys are catalog keys by construction.
    return Object.freeze({
      factories: Object.freeze(factories),
    }) as FactoryRegistrySnapshot<FactoryCatalogKey<Catalog>>
  }

  #registerPolicies(policies: FactoryPolicyMap<Catalog>): void {
    const policyEntries = Object.entries(policies) as [
      string,
      FactoryPolicyOverrides | undefined,
    ][]

    for (const [key, overrides] of policyEntries) {
      if (overrides === undefined) {
        continue
      }

      if (!isFactoryKey(key) || !Object.hasOwn(this.#catalog, key)) {
        throw new FactoryRegistryError(
          'INVALID_POLICY',
          `Policy overrides reference unknown factory "${key}".`,
          { details: { key } },
        )
      }

      const parsed = factoryPolicyOverridesSchema.safeParse(overrides)
      if (!parsed.success) {
        throw new FactoryRegistryError(
          'INVALID_POLICY',
          `Policy overrides for factory "${key}" are invalid.`,
          {
            cause: parsed.error,
            details: { issues: parsed.error.issues, key },
          },
        )
      }

      this.#policyOverrides.set(key, overrides)
    }
  }

  #entryPolicy(key: string): FactoryEntryPolicy {
    const overrides = this.#policyOverrides.get(key)
    return {
      circuitFailureThreshold:
        overrides?.circuitBreaker?.failureThreshold ??
        this.#circuitFailureThreshold,
      circuitResetTimeoutMs:
        overrides?.circuitBreaker?.resetTimeoutMs ??
        this.#circuitResetTimeoutMs,
      creationTimeoutMs:
        overrides?.creationTimeoutMs ?? this.#creationTimeoutMs,
      maxConcurrentCreations:
        overrides?.maxConcurrentCreations ?? this.#maxConcurrentCreations,
    }
  }

  #emit(event: FactoryRegistryEvent): void {
    const listener = this.#onEvent
    if (listener === undefined) {
      return
    }

    try {
      // Every emitted key is a registered canonical key, so the narrowing
      // to the catalog's key union is guaranteed by construction.
      listener(
        Object.freeze(event) as FactoryRegistryEvent<
          FactoryCatalogKey<Catalog>
        >,
      )
    } catch {
      // Observability must never alter registry behavior.
    }
  }

  #registerAliases(aliases: Aliases): void {
    const pending = new Map<string, FactoryKey>()

    for (const [alias, target] of Object.entries(aliases)) {
      if (!isFactoryAlias(alias) || !isFactoryKey(target)) {
        throw new FactoryRegistryError(
          'INVALID_SOURCE',
          'The registry contains an invalid factory alias mapping.',
          { details: { alias, target } },
        )
      }

      if (this.#entries.has(alias)) {
        throw new FactoryRegistryError(
          'ALIAS_COLLISION',
          `Factory alias "${alias}" collides with a canonical factory key.`,
          { details: { alias, target } },
        )
      }

      if (!this.#entries.has(target)) {
        throw new FactoryRegistryError(
          'UNKNOWN_ALIAS_TARGET',
          `Factory alias "${alias}" points to unknown factory "${target}".`,
          { details: { alias, target } },
        )
      }

      if (this.#aliasTargets.has(alias) || pending.has(alias)) {
        throw new FactoryRegistryError(
          'ALIAS_COLLISION',
          `Factory alias "${alias}" is registered more than once.`,
          { details: { alias, target } },
        )
      }

      pending.set(alias, target)
    }

    for (const [alias, target] of pending) {
      this.#aliasTargets.set(alias, target)
    }
  }

  #resolveCanonicalKey(key: FactoryKey | FactoryAlias): FactoryKey {
    if (this.#entries.has(key)) {
      return key as FactoryKey
    }

    const aliasTarget = this.#aliasTargets.get(key)
    if (aliasTarget !== undefined) {
      return aliasTarget
    }

    throw new FactoryRegistryError(
      'UNKNOWN_FACTORY',
      `No factory is registered for "${key}".`,
      { details: { key } },
    )
  }

  #requiredContract(key: FactoryKey): FactoryContract {
    const contract = this.#catalog[key]
    if (contract === undefined) {
      throw new FactoryRegistryError(
        'INVALID_SOURCE',
        `Factory key "${key}" has no schema contract in the catalog.`,
        { details: { key } },
      )
    }

    return contract
  }

  #requiredEntry(key: FactoryKey): RegistryEntry<Catalog> {
    const entry = this.#entries.get(key)
    if (entry === undefined) {
      throw new FactoryRegistryError(
        'UNKNOWN_FACTORY',
        `No factory is registered for "${key}".`,
        { details: { key } },
      )
    }

    return entry
  }

  #loadFactory(key: FactoryKey): Promise<CatalogFactory<Catalog>> {
    const entry = this.#requiredEntry(key)

    if (entry.state.status === 'ready') {
      return Promise.resolve(entry.state.factory)
    }

    if (entry.state.status === 'loading') {
      return entry.state.promise
    }

    if (entry.state.status === 'failed' && this.#cacheFailures) {
      return Promise.reject(entry.state.error)
    }

    return this.#startLoading(entry)
  }

  #startLoading(
    entry: RegistryEntry<Catalog>,
  ): Promise<CatalogFactory<Catalog>> {
    const revision = entry.revision
    const promise = this.#importFactory(entry.source).then(
      (factory) => {
        if (entry.revision === revision) {
          entry.state = { factory, status: 'ready' }
        }
        this.#emit({ key: entry.source.key, type: 'factory-loaded' })
        return factory
      },
      (error: unknown) => {
        const normalizedError = normalizeFactoryRegistryError(error)
        if (entry.revision === revision) {
          entry.state = this.#cacheFailures
            ? { error: normalizedError, status: 'failed' }
            : { status: 'idle' }
        }
        this.#emit({
          code: normalizedError.code,
          key: entry.source.key,
          type: 'factory-load-failed',
        })
        throw normalizedError
      },
    )

    entry.state = { promise, status: 'loading' }
    return promise
  }

  #importFactory(
    source: RuntimeSource<Catalog>,
  ): Promise<CatalogFactory<Catalog>> {
    const operation = this.#loadAndValidateFactory(source)
    const timeoutError = new FactoryRegistryError(
      'MODULE_LOAD_TIMEOUT',
      `Factory module "${source.modulePath}" did not load within ${this.#loadTimeoutMs}ms.`,
      {
        details: {
          key: source.key,
          modulePath: source.modulePath,
          timeoutMs: this.#loadTimeoutMs,
        },
      },
    )

    return this.#withTimeout(operation, this.#loadTimeoutMs, timeoutError)
  }

  async #loadAndValidateFactory(
    source: RuntimeSource<Catalog>,
  ): Promise<CatalogFactory<Catalog>> {
    let moduleValue: CatalogFactoryModule<Catalog>

    try {
      moduleValue = await source.load()
    } catch (cause) {
      throw new FactoryRegistryError(
        'MODULE_LOAD_FAILED',
        `Could not load factory module "${source.modulePath}".`,
        {
          cause,
          details: { key: source.key, modulePath: source.modulePath },
        },
      )
    }

    const parsedModule = await factoryModuleBoundarySchema.safeParseAsync(
      moduleValue,
    )
    if (!parsedModule.success) {
      throw new FactoryRegistryError(
        'INVALID_FACTORY_MODULE',
        `Factory module "${source.modulePath}" failed schema validation.`,
        {
          cause: parsedModule.error,
          details: {
            issues: parsedModule.error.issues,
            key: source.key,
            modulePath: source.modulePath,
          },
        },
      )
    }

    const validatedFactory = parsedModule.data.default
    if (validatedFactory.key !== source.key) {
      throw new FactoryRegistryError(
        'FACTORY_KEY_MISMATCH',
        `Factory module "${source.modulePath}" declared "${validatedFactory.key}" but was registered as "${source.key}".`,
        {
          details: {
            actualKey: validatedFactory.key,
            expectedKey: source.key,
            modulePath: source.modulePath,
          },
        },
      )
    }

    const contract = Reflect.get(this.#catalog, source.key) as FactoryContract
    if (validatedFactory.productType !== contract.productType) {
      throw new FactoryRegistryError(
        'FACTORY_PRODUCT_TYPE_MISMATCH',
        `Factory module "${source.modulePath}" declared product type "${validatedFactory.productType}" but its contract declares "${contract.productType}".`,
        {
          details: {
            actualProductType: validatedFactory.productType,
            expectedProductType: contract.productType,
            key: source.key,
            modulePath: source.modulePath,
          },
        },
      )
    }

    const immutableReceiver = Object.freeze({
      create: validatedFactory.create,
      key: validatedFactory.key,
      metadata: validatedFactory.metadata,
      productType: validatedFactory.productType,
    })
    const capturedCreate = validatedFactory.create.bind(immutableReceiver)
    return Object.freeze({
      create: capturedCreate,
      key: validatedFactory.key,
      metadata: validatedFactory.metadata,
      productType: validatedFactory.productType,
    }) as CatalogFactory<Catalog>
  }

  #acquireExecutionSlot(
    entry: RegistryEntry<Catalog>,
    key: FactoryKey,
    correlationId?: string,
  ): () => void {
    if (entry.activeCreations >= entry.policy.maxConcurrentCreations) {
      this.#emit({
        ...(correlationId === undefined ? {} : { correlationId }),
        code: 'FACTORY_BUSY',
        key,
        type: 'creation-failed',
      })
      throw new FactoryRegistryError(
        'FACTORY_BUSY',
        `Factory "${key}" reached its concurrency limit.`,
        {
          details: {
            activeCreations: entry.activeCreations,
            key,
            maxConcurrentCreations: entry.policy.maxConcurrentCreations,
          },
        },
      )
    }

    entry.activeCreations += 1
    let released = false
    return () => {
      if (!released) {
        released = true
        // resetConcurrency() may have already reclaimed this slot.
        entry.activeCreations = Math.max(0, entry.activeCreations - 1)
      }
    }
  }

  #acquireCircuitPermit(
    entry: RegistryEntry<Catalog>,
    key: FactoryKey,
    correlationId?: string,
  ): CircuitPermit {
    const circuit = entry.circuit
    const rejectCreation = (retryAfterMs?: number): FactoryRegistryError => {
      this.#emit({
        ...(correlationId === undefined ? {} : { correlationId }),
        code: 'CIRCUIT_OPEN',
        key,
        type: 'creation-failed',
      })
      return this.#circuitOpenError(key, retryAfterMs)
    }

    if (circuit.status === 'closed') {
      return { generation: circuit.generation, kind: 'closed' }
    }

    // A probe is already in flight; no retry delay can be promised.
    if (circuit.status === 'half-open') {
      throw rejectCreation()
    }

    const elapsedMs = Date.now() - circuit.openedAt
    if (elapsedMs < entry.policy.circuitResetTimeoutMs) {
      throw rejectCreation(entry.policy.circuitResetTimeoutMs - elapsedMs)
    }

    const probeToken = Symbol('factory-circuit-probe')
    const generation = circuit.generation + 1
    entry.circuit = {
      consecutiveFailures: circuit.consecutiveFailures,
      generation,
      openedAt: circuit.openedAt,
      probeToken,
      status: 'half-open',
    }
    this.#emit({ key, type: 'circuit-probed' })
    return { generation, kind: 'half-open', probeToken }
  }

  /**
   * Returns a half-open circuit to the open state when its probe ends with a
   * neutral outcome (for example a caller abort) that says nothing about
   * factory health. The original openedAt is preserved, so the reset window
   * has already elapsed and the next creation is admitted as a fresh probe.
   */
  #releaseCircuitProbe(
    entry: RegistryEntry<Catalog>,
    permit: CircuitPermit,
  ): void {
    const circuit = entry.circuit

    if (
      permit.kind === 'half-open' &&
      circuit.status === 'half-open' &&
      circuit.generation === permit.generation &&
      circuit.probeToken === permit.probeToken
    ) {
      entry.circuit = {
        consecutiveFailures: circuit.consecutiveFailures,
        generation: circuit.generation + 1,
        openedAt: circuit.openedAt,
        status: 'open',
      }
      this.#emit({ key: entry.source.key, type: 'circuit-re-armed' })
    }
  }

  #recordCircuitSuccess(
    entry: RegistryEntry<Catalog>,
    permit: CircuitPermit,
  ): void {
    const circuit = entry.circuit

    if (
      permit.kind === 'half-open' &&
      circuit.status === 'half-open' &&
      circuit.generation === permit.generation &&
      circuit.probeToken === permit.probeToken
    ) {
      entry.circuit = closedCircuit(circuit.generation + 1)
      this.#emit({ key: entry.source.key, type: 'circuit-closed' })
      return
    }

    if (
      permit.kind === 'closed' &&
      circuit.status === 'closed' &&
      circuit.generation === permit.generation &&
      circuit.consecutiveFailures !== 0
    ) {
      entry.circuit = closedCircuit(circuit.generation)
    }
  }

  #recordCircuitFailure(
    entry: RegistryEntry<Catalog>,
    permit: CircuitPermit,
  ): void {
    const circuit = entry.circuit

    if (
      permit.kind === 'half-open' &&
      circuit.status === 'half-open' &&
      circuit.generation === permit.generation &&
      circuit.probeToken === permit.probeToken
    ) {
      const consecutiveFailures = circuit.consecutiveFailures + 1
      entry.circuit = {
        consecutiveFailures,
        generation: circuit.generation + 1,
        openedAt: Date.now(),
        status: 'open',
      }
      this.#emit({
        consecutiveFailures,
        key: entry.source.key,
        type: 'circuit-opened',
      })
      return
    }

    if (
      permit.kind !== 'closed' ||
      circuit.status !== 'closed' ||
      circuit.generation !== permit.generation
    ) {
      return
    }

    const consecutiveFailures = circuit.consecutiveFailures + 1
    if (consecutiveFailures >= entry.policy.circuitFailureThreshold) {
      entry.circuit = {
        consecutiveFailures,
        generation: circuit.generation + 1,
        openedAt: Date.now(),
        status: 'open',
      }
      this.#emit({
        consecutiveFailures,
        key: entry.source.key,
        type: 'circuit-opened',
      })
    } else {
      entry.circuit = {
        consecutiveFailures,
        generation: circuit.generation,
        status: 'closed',
      }
    }
  }

  #circuitOpenError(
    key: FactoryKey,
    retryAfterMs?: number,
  ): FactoryRegistryError {
    return new FactoryRegistryError(
      'CIRCUIT_OPEN',
      `Factory "${key}" is temporarily unavailable because its circuit is open.`,
      {
        details: {
          key,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      },
    )
  }

  #executionOptions(
    options: FactoryCreateOptions,
    key: FactoryKey | FactoryAlias,
  ): Readonly<FactoryCreateOptions> {
    const result = factoryCreateOptionsSchema.safeParse(options)
    if (!result.success) {
      throw new FactoryRegistryError(
        'INVALID_EXECUTION_OPTIONS',
        `Factory creation for "${key}" has invalid execution options.`,
        { cause: result.error, details: { issues: result.error.issues, key } },
      )
    }

    const normalized: FactoryCreateOptions = {
      ...(result.data.correlationId === undefined
        ? {}
        : { correlationId: result.data.correlationId }),
      ...(result.data.signal === undefined
        ? {}
        : { signal: result.data.signal }),
      ...(result.data.timeoutMs === undefined
        ? {}
        : { timeoutMs: result.data.timeoutMs }),
    }
    return Object.freeze(normalized)
  }

  #runWithExecutionControls<Value>(
    key: FactoryKey | FactoryAlias,
    timeoutMs: number,
    options: FactoryCreateOptions,
    onWorkSettled: () => void,
    run: (effectiveOptions: FactoryCreateOptions) => Awaitable<Value>,
  ): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      const controller = new AbortController()
      let settled = false
      let workSettled = false
      let timeout: ReturnType<typeof setTimeout> | undefined

      const cleanup = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        options.signal?.removeEventListener('abort', onUserAbort)
      }
      const settleWork = (): void => {
        if (!workSettled) {
          workSettled = true
          onWorkSettled()
        }
      }
      const resolveOnce = (value: Value): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(value)
      }
      const rejectOnce = (reason: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(reason)
      }
      const onUserAbort = (): void => {
        const signal = options.signal
        if (signal === undefined) {
          return
        }
        controller.abort(signal.reason)
        rejectOnce(this.#abortedError(key, signal))
      }

      options.signal?.addEventListener('abort', onUserAbort, { once: true })
      if (options.signal?.aborted === true) {
        onUserAbort()
        settleWork()
        return
      }

      timeout = setTimeout(() => {
        const error = new FactoryRegistryError(
          'FACTORY_CREATION_TIMEOUT',
          `Factory creation for "${key}" exceeded ${timeoutMs}ms.`,
          { details: { key, timeoutMs } },
        )
        controller.abort(error)
        rejectOnce(error)
      }, timeoutMs)

      const effectiveOptions: FactoryCreateOptions = Object.freeze({
        ...options,
        signal: controller.signal,
        timeoutMs,
      })

      let operation: Awaitable<Value>
      try {
        operation = run(effectiveOptions)
      } catch (error) {
        settleWork()
        rejectOnce(error)
        return
      }

      Promise.resolve(operation).then(
        (value) => {
          settleWork()
          resolveOnce(value)
        },
        (error: unknown) => {
          settleWork()
          rejectOnce(error)
        },
      )
    })
  }

  #withTimeout<Value>(
    operation: Promise<Value>,
    timeoutMs: number,
    timeoutError: FactoryRegistryError,
  ): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(timeoutError)
        }
      }, timeoutMs)

      operation.then(
        (value) => {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            resolve(value)
          }
        },
        (error: unknown) => {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            reject(error)
          }
        },
      )
    })
  }

  #normalizeExecutionError(
    error: unknown,
    key: FactoryKey,
  ): FactoryRegistryError {
    if (
      isFactoryRegistryError(error) &&
      (error.code === 'ABORTED' ||
        error.code === 'FACTORY_CREATION_TIMEOUT' ||
        error.code === 'INVALID_FACTORY_RESULT')
    ) {
      return error
    }

    return new FactoryRegistryError(
      'FACTORY_CREATION_FAILED',
      `Factory "${key}" failed while creating its product family.`,
      { cause: error, details: { key } },
    )
  }

  #countsTowardCircuit(error: FactoryRegistryError): boolean {
    return (
      error.code === 'FACTORY_CREATION_FAILED' ||
      error.code === 'FACTORY_CREATION_TIMEOUT' ||
      error.code === 'INVALID_FACTORY_RESULT'
    )
  }

  /**
   * Rejects this caller as soon as their signal aborts, without cancelling
   * the shared operation (other callers may be awaiting the same load). The
   * abandoned operation's eventual rejection is silenced to avoid an
   * unhandled-rejection report when no caller remains.
   */
  #awaitWithAbort<Value>(
    operation: Promise<Value>,
    key: FactoryKey | FactoryAlias,
    signal: AbortSignal | undefined,
  ): Promise<Value> {
    if (signal === undefined) {
      return operation
    }

    if (signal.aborted) {
      operation.catch(() => {})
      return Promise.reject(this.#abortedError(key, signal))
    }

    return new Promise<Value>((resolve, reject) => {
      const onAbort = (): void => {
        operation.catch(() => {})
        reject(this.#abortedError(key, signal))
      }

      signal.addEventListener('abort', onAbort, { once: true })
      operation.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  #assertNotAborted(
    key: FactoryKey | FactoryAlias,
    signal: AbortSignal | undefined,
  ): void {
    if (signal?.aborted === true) {
      throw this.#abortedError(key, signal)
    }
  }

  #abortedError(
    key: FactoryKey | FactoryAlias,
    signal: AbortSignal,
  ): FactoryRegistryError {
    return new FactoryRegistryError(
      'ABORTED',
      `Factory creation for "${key}" was aborted.`,
      { cause: signal.reason, details: { key } },
    )
  }
}

export function smartFactoryRegistryFor<const Catalog extends FactoryCatalog>(
  catalog: Catalog,
) {
  return <
    const Aliases extends FactoryAliasMap<Catalog> = EmptyFactoryAliasMap,
  >(
    options: Omit<
      SmartFactoryRegistryOptions<Catalog, Aliases>,
      'catalog'
    >,
  ): SmartFactoryRegistry<Catalog, Aliases> =>
    new SmartFactoryRegistry<Catalog, Aliases>({ ...options, catalog })
}
