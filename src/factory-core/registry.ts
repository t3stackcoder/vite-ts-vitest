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
import {
  FactoryEntryExecution,
  assertNotAborted,
  awaitWithAbort,
  runWithExecutionControls,
  withTimeout,
  type CircuitPermit,
  type FactoryCircuitSnapshot,
  type FactoryEntryPolicy,
} from './execution'

export type { FactoryCircuitSnapshot, FactoryCircuitStatus } from './execution'

const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3
const DEFAULT_CIRCUIT_RESET_TIMEOUT_MS = 30_000
const DEFAULT_CREATION_TIMEOUT_MS = 30_000
const DEFAULT_LOAD_TIMEOUT_MS = 15_000
const DEFAULT_MAX_CONCURRENT_CREATIONS = 16

export type FactoryLoadStatus = 'failed' | 'idle' | 'loading' | 'ready'

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

interface RegistryEntry<Catalog extends FactoryCatalog> {
  readonly execution: FactoryEntryExecution
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

/** Host-locale-independent ordering for deterministic reports/snapshots. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
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

    // The private helper, not the public register(): the class is not
    // designed for extension, but a subclass override must not run before
    // the subclass's own field initializers.
    this.#register(options.sources)

    if (options.aliases !== undefined) {
      this.#registerAliases(options.aliases)
    }
  }

  register(sources: readonly FactorySource<Catalog>[]): void {
    this.#register(sources)
  }

  #register(sources: readonly FactorySource<Catalog>[]): void {
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
        execution: new FactoryEntryExecution({
          emit: (event) => {
            this.#emit(event)
          },
          key: source.key,
          policy: this.#entryPolicy(key),
        }),
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
    assertNotAborted(key, executionOptions.signal)
    const canonicalKey = this.#resolveCanonicalKey(key)
    const entry = this.#requiredEntry(canonicalKey)
    const executionTimeoutMs =
      executionOptions.timeoutMs ?? entry.execution.policy.creationTimeoutMs
    const contract = this.#requiredContract(canonicalKey)
    // Context validation runs before the module load, but never outside the
    // bounded envelope create() promises: a hanging async refinement is cut
    // off by the creation timeout, and the caller's signal is honored while
    // the parse is in flight, not only polled before and after it.
    const contextResult = await awaitWithAbort(
      withTimeout(
        contract.contextSchema.safeParseAsync(context),
        executionTimeoutMs,
        new FactoryRegistryError(
          'FACTORY_CREATION_TIMEOUT',
          `Context validation for factory "${canonicalKey}" exceeded ${executionTimeoutMs}ms.`,
          { details: { key: canonicalKey, timeoutMs: executionTimeoutMs } },
        ),
      ),
      key,
      executionOptions.signal,
    )

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

    assertNotAborted(key, executionOptions.signal)
    const factory = await awaitWithAbort(
      this.#loadFactory(canonicalKey),
      key,
      executionOptions.signal,
    )
    assertNotAborted(key, executionOptions.signal)
    const releaseSlot = entry.execution.acquireSlot(
      executionOptions.correlationId,
    )

    let circuitPermit: CircuitPermit
    try {
      circuitPermit = entry.execution.acquireCircuitPermit(
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
      const validatedResult = await runWithExecutionControls(
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

      entry.execution.recordCircuitSuccess(circuitPermit)
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
        entry.execution.recordCircuitFailure(circuitPermit)
      } else {
        entry.execution.releaseCircuitProbe(circuitPermit)
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
    entry.execution.resetCircuit()
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
    entry.execution.resetConcurrency()
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

    loaded.sort(compareCodeUnits)
    failed.sort((left, right) => compareCodeUnits(left.key, right.key))

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
        .sort(compareCodeUnits)
      const errorCode =
        entry.state.status === 'failed' ? entry.state.error.code : undefined

      return Object.freeze({
        activeCreations: entry.execution.activeCreations,
        aliases: Object.freeze(aliases),
        circuit: entry.execution.circuit,
        ...(errorCode === undefined ? {} : { errorCode }),
        key: entry.source.key,
        modulePath: entry.source.modulePath,
        status: entry.state.status,
      })
    })

    factories.sort((left, right) => compareCodeUnits(left.key, right.key))
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
        // A revision advanced by invalidate() means this load was
        // superseded: the registry does not adopt the result, so no load
        // event is emitted either — telemetry must agree with snapshot().
        if (entry.revision === revision) {
          entry.state = { factory, status: 'ready' }
          this.#emit({ key: entry.source.key, type: 'factory-loaded' })
        }
        return factory
      },
      (error: unknown) => {
        const normalizedError = normalizeFactoryRegistryError(error)
        if (entry.revision === revision) {
          entry.state = this.#cacheFailures
            ? { error: normalizedError, status: 'failed' }
            : { status: 'idle' }
          this.#emit({
            code: normalizedError.code,
            key: entry.source.key,
            type: 'factory-load-failed',
          })
        }
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

    return withTimeout(operation, this.#loadTimeoutMs, timeoutError)
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
