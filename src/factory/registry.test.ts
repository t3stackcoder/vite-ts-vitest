import { z } from 'zod'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createFilenameKeyResolver,
  createGlobFactorySources,
  defineFactoryCatalog,
  defineFactoryFor,
  factoryAlias,
  factoryCatalogEntry,
  factoryAliasSet,
  factoryContract,
  factoryKey,
  factoryKeySet,
  factoryNamespace,
  modulePath,
  smartFactoryRegistryFor,
  type Awaitable,
  type CatalogFactoryModule,
  type FactoryAlias,
  type FactoryCreateOptions,
  type FactoryKey,
  type FactoryRegistryEvent,
  type FactorySource,
  type GlobLoaderMap,
} from '.'
import * as publicApi from '.'

const ALPHA_FACTORY = factoryKey('test:alpha')
const BETA_FACTORY = factoryKey('test:beta')
const LEGACY_ALPHA_ALIAS = factoryAlias('test:legacy-alpha')

const alphaContextSchema = z.strictObject({ value: z.number().finite() }).readonly()
const alphaResultSchema = z
  .strictObject({
    doubled: z.number().finite(),
    kind: z.literal('alpha'),
  })
  .readonly()
const betaContextSchema = z.strictObject({ text: z.string() }).readonly()
const betaResultSchema = z
  .strictObject({
    kind: z.literal('beta'),
    uppercased: z.string(),
  })
  .readonly()

type AlphaContext = z.output<typeof alphaContextSchema>
type AlphaResult = z.output<typeof alphaResultSchema>

const TEST_CATALOG = defineFactoryCatalog({
  ...factoryCatalogEntry(
    ALPHA_FACTORY,
    factoryContract(alphaContextSchema, alphaResultSchema),
  ),
  ...factoryCatalogEntry(
    BETA_FACTORY,
    factoryContract(betaContextSchema, betaResultSchema),
  ),
})

type TestCatalog = typeof TEST_CATALOG

const defineTestFactory = defineFactoryFor<TestCatalog>()
const createTestRegistry = smartFactoryRegistryFor(TEST_CATALOG)

function alphaFactory(
  create: (
    context: AlphaContext,
    options?: FactoryCreateOptions,
  ) => Awaitable<AlphaResult> = (context) => ({
    doubled: context.value * 2,
    kind: 'alpha',
  }),
) {
  return defineTestFactory(ALPHA_FACTORY)({
    create,
    metadata: {
      displayName: 'Alpha Factory',
      version: '1.0.0',
    },
  })
}

function betaFactory() {
  return defineTestFactory(BETA_FACTORY)({
    create: (context) => ({
      kind: 'beta',
      uppercased: context.text.toUpperCase(),
    }),
    metadata: {
      displayName: 'Beta Factory',
      version: '1.0.0',
    },
  })
}

function source<Key extends typeof ALPHA_FACTORY | typeof BETA_FACTORY>(
  key: Key,
  filename: string,
  load: () => Promise<CatalogFactoryModule<TestCatalog>>,
): FactorySource<TestCatalog, Key> {
  return {
    key,
    load,
    modulePath: modulePath(`./fixtures/${filename}.factory.ts`),
  }
}

/** Simulates malformed JavaScript crossing an otherwise typed module boundary. */
function untrustedModule(value: unknown): CatalogFactoryModule<TestCatalog> {
  return value as CatalogFactoryModule<TestCatalog>
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SmartFactoryRegistry', () => {
  it('loads lazily and deduplicates concurrent module imports', async () => {
    const load = vi.fn(async () => ({ default: alphaFactory() }))
    const registry = createTestRegistry({
      sources: [source(ALPHA_FACTORY, 'alpha', load)],
    })

    expect(load).not.toHaveBeenCalled()

    const [first, second] = await Promise.all([
      registry.create(ALPHA_FACTORY, { value: 3 }),
      registry.create(ALPHA_FACTORY, { value: 7 }),
    ])

    expect(load).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ doubled: 6, kind: 'alpha' })
    expect(second).toEqual({ doubled: 14, kind: 'alpha' })
    expectTypeOf(first).toEqualTypeOf<AlphaResult>()
  })

  it('preserves context and result inference through a typed alias', async () => {
    const aliases = {
      [LEGACY_ALPHA_ALIAS]: ALPHA_FACTORY,
    } as const
    const registry = createTestRegistry({
      aliases,
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(),
        })),
      ],
    })

    const result = await registry.create(LEGACY_ALPHA_ALIAS, { value: 5 })

    expect(result.doubled).toBe(10)
    expect(registry.canonicalKey(LEGACY_ALPHA_ALIAS)).toBe(ALPHA_FACTORY)
    expectTypeOf(result).toEqualTypeOf<AlphaResult>()
  })

  it('does not expose a raw factory resolver', () => {
    const registry = createTestRegistry({
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(),
        })),
      ],
    })

    expect('resolve' in registry).toBe(false)
  })

  it('rejects duplicate registration atomically', () => {
    const registry = createTestRegistry({
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(),
        })),
      ],
    })

    expect(() =>
      registry.register([
        source(BETA_FACTORY, 'beta', async () => ({ default: betaFactory() })),
        source(ALPHA_FACTORY, 'alpha-copy', async () => ({
          default: alphaFactory(),
        })),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'DUPLICATE_FACTORY' }))
    expect(registry.has(BETA_FACTORY)).toBe(false)
  })

  it('uses Zod to validate a module that lied about its generic type', async () => {
    const registry = createTestRegistry({
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () =>
          untrustedModule({
            default: {
              create: () => ({ doubled: 2, kind: 'alpha' }),
              key: ALPHA_FACTORY,
              metadata: { displayName: 'Broken', version: 'not-semver' },
            },
          }),
        ),
      ],
    })

    const report = await registry.preload([ALPHA_FACTORY])

    expect(report.failed[0]?.error).toMatchObject({
      code: 'INVALID_FACTORY_MODULE',
    })
  })

  it('detects disagreement between the path-derived and exported keys', async () => {
    const registry = createTestRegistry({
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: betaFactory(),
        })),
      ],
    })

    const report = await registry.preload([ALPHA_FACTORY])

    expect(report.failed[0]?.error).toMatchObject({
      code: 'FACTORY_KEY_MISMATCH',
    })
  })

  it('captures an immutable factory wrapper instead of retaining a mutable export', async () => {
    const mutableFactory = {
      create(context: AlphaContext): AlphaResult {
        return {
          doubled: this.key === ALPHA_FACTORY ? context.value * 2 : -1,
          kind: 'alpha',
        }
      },
      key: ALPHA_FACTORY as typeof ALPHA_FACTORY | typeof BETA_FACTORY,
      metadata: { displayName: 'Mutable Alpha', version: '1.0.0' },
    }
    const registry = createTestRegistry({
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () =>
          untrustedModule({ default: mutableFactory }),
        ),
      ],
    })

    await expect(registry.create(ALPHA_FACTORY, { value: 2 })).resolves.toEqual(
      { doubled: 4, kind: 'alpha' },
    )

    mutableFactory.key = BETA_FACTORY
    mutableFactory.create = () => ({ doubled: -999, kind: 'alpha' })
    mutableFactory.metadata.version = 'malicious-mutation'

    await expect(registry.create(ALPHA_FACTORY, { value: 3 })).resolves.toEqual(
      { doubled: 6, kind: 'alpha' },
    )
  })

  it('validates context before loading a factory chunk', async () => {
    const create = vi.fn((context: AlphaContext): AlphaResult => ({
      doubled: context.value * 2,
      kind: 'alpha',
    }))
    const load = vi.fn(async () => ({ default: alphaFactory(create) }))
    const registry = createTestRegistry({
      sources: [source(ALPHA_FACTORY, 'alpha', load)],
    })

    await expect(
      registry.create(ALPHA_FACTORY, { value: Number.NaN }),
    ).rejects.toMatchObject({ code: 'INVALID_FACTORY_CONTEXT' })
    expect(load).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('validates execution options before loading a factory chunk', async () => {
    const load = vi.fn(async () => ({ default: alphaFactory() }))
    const registry = createTestRegistry({
      sources: [source(ALPHA_FACTORY, 'alpha', load)],
    })

    await expect(
      registry.create(ALPHA_FACTORY, { value: 1 }, { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_EXECUTION_OPTIONS' })
    expect(load).not.toHaveBeenCalled()
  })

  it('validates factory results before exposing them to callers', async () => {
    const registry = createTestRegistry({
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () =>
          untrustedModule({
            default: {
              create: () => ({ doubled: 'not-a-number', kind: 'alpha' }),
              key: ALPHA_FACTORY,
              metadata: { displayName: 'Untrusted Alpha', version: '1.0.0' },
            },
          }),
        ),
      ],
    })

    await expect(
      registry.create(ALPHA_FACTORY, { value: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_FACTORY_RESULT' })
  })

  it('caches load failures until explicitly invalidated', async () => {
    let attempt = 0
    const load = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        throw new Error('temporary chunk failure')
      }
      return { default: alphaFactory() }
    })
    const registry = createTestRegistry({
      sources: [source(ALPHA_FACTORY, 'alpha', load)],
    })

    await expect(
      registry.create(ALPHA_FACTORY, { value: 4 }),
    ).rejects.toMatchObject({ code: 'MODULE_LOAD_FAILED' })
    await expect(
      registry.create(ALPHA_FACTORY, { value: 4 }),
    ).rejects.toMatchObject({ code: 'MODULE_LOAD_FAILED' })
    expect(load).toHaveBeenCalledTimes(1)

    registry.invalidate(ALPHA_FACTORY)
    await expect(registry.create(ALPHA_FACTORY, { value: 4 })).resolves.toEqual(
      { doubled: 8, kind: 'alpha' },
    )
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('bounds module loading with a hard deadline', async () => {
    vi.useFakeTimers()
    const registry = createTestRegistry({
      loadTimeoutMs: 25,
      sources: [
        source(
          ALPHA_FACTORY,
          'alpha',
          () => new Promise<CatalogFactoryModule<TestCatalog>>(() => {}),
        ),
      ],
    })

    const reportPromise = registry.preload([ALPHA_FACTORY])
    await vi.advanceTimersByTimeAsync(25)
    const report = await reportPromise

    expect(report.failed[0]?.error).toMatchObject({
      code: 'MODULE_LOAD_TIMEOUT',
    })
    expect(registry.snapshot().factories[0]).toMatchObject({
      errorCode: 'MODULE_LOAD_TIMEOUT',
      status: 'failed',
    })
  })

  it('times out uncooperative work without releasing its bulkhead slot', async () => {
    vi.useFakeTimers()
    let forwardedSignal: AbortSignal | undefined
    const registry = createTestRegistry({
      creationTimeoutMs: 20,
      maxConcurrentCreations: 1,
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory((_context, options) => {
            forwardedSignal = options?.signal
            return new Promise<AlphaResult>(() => {})
          }),
        })),
      ],
    })

    const creation = registry.create(ALPHA_FACTORY, { value: 1 })
    const timeoutAssertion = expect(creation).rejects.toMatchObject({
      code: 'FACTORY_CREATION_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(20)
    await timeoutAssertion

    expect(forwardedSignal?.aborted).toBe(true)
    expect(registry.snapshot().factories[0]).toMatchObject({
      activeCreations: 1,
      circuit: { consecutiveFailures: 1, status: 'closed' },
    })
    await expect(
      registry.create(ALPHA_FACTORY, { value: 2 }),
    ).rejects.toMatchObject({ code: 'FACTORY_BUSY' })
  })

  it('enforces and releases the per-factory concurrency bulkhead', async () => {
    const gate = deferred<AlphaResult>()
    const started = deferred<void>()
    const registry = createTestRegistry({
      maxConcurrentCreations: 1,
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(() => {
            started.resolve(undefined)
            return gate.promise
          }),
        })),
      ],
    })

    const first = registry.create(ALPHA_FACTORY, { value: 1 })
    await started.promise

    await expect(
      registry.create(ALPHA_FACTORY, { value: 2 }),
    ).rejects.toMatchObject({ code: 'FACTORY_BUSY' })
    expect(registry.snapshot().factories[0]?.activeCreations).toBe(1)

    gate.resolve({ doubled: 2, kind: 'alpha' })
    await expect(first).resolves.toEqual({ doubled: 2, kind: 'alpha' })
    expect(registry.snapshot().factories[0]?.activeCreations).toBe(0)
  })

  it('opens, probes, and recovers a per-factory circuit breaker', async () => {
    vi.useFakeTimers()
    const probeGate = deferred<AlphaResult>()
    const probeStarted = deferred<void>()
    let attempts = 0
    const create = vi.fn((context: AlphaContext): Awaitable<AlphaResult> => {
      attempts += 1
      if (attempts <= 2) {
        throw new Error(`failure ${attempts}`)
      }
      probeStarted.resolve(undefined)
      return probeGate.promise.then(() => ({
        doubled: context.value * 2,
        kind: 'alpha',
      }))
    })
    const registry = createTestRegistry({
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 100 },
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(create),
        })),
      ],
    })

    await expect(
      registry.create(ALPHA_FACTORY, { value: 1 }),
    ).rejects.toMatchObject({ code: 'FACTORY_CREATION_FAILED' })
    await expect(
      registry.create(ALPHA_FACTORY, { value: 1 }),
    ).rejects.toMatchObject({ code: 'FACTORY_CREATION_FAILED' })
    await expect(
      registry.create(ALPHA_FACTORY, { value: 1 }),
    ).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' })
    expect(create).toHaveBeenCalledTimes(2)
    expect(registry.snapshot().factories[0]?.circuit).toEqual({
      consecutiveFailures: 2,
      status: 'open',
    })

    await vi.advanceTimersByTimeAsync(100)
    const probe = registry.create(ALPHA_FACTORY, { value: 3 })
    await probeStarted.promise
    expect(registry.snapshot().factories[0]?.circuit.status).toBe('half-open')
    await expect(
      registry.create(ALPHA_FACTORY, { value: 4 }),
    ).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' })

    probeGate.resolve({ doubled: 6, kind: 'alpha' })
    await expect(probe).resolves.toEqual({ doubled: 6, kind: 'alpha' })
    expect(registry.snapshot().factories[0]?.circuit).toEqual({
      consecutiveFailures: 0,
      status: 'closed',
    })
  })

  it('re-arms an open circuit when its half-open probe is aborted', async () => {
    vi.useFakeTimers()
    const probeStarted = deferred<void>()
    let attempts = 0
    const registry = createTestRegistry({
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 100 },
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory((context) => {
            attempts += 1
            if (attempts === 1) {
              throw new Error('failure 1')
            }
            if (attempts === 2) {
              probeStarted.resolve(undefined)
              return new Promise<AlphaResult>(() => {})
            }
            return { doubled: context.value * 2, kind: 'alpha' }
          }),
        })),
      ],
    })

    await expect(
      registry.create(ALPHA_FACTORY, { value: 1 }),
    ).rejects.toMatchObject({ code: 'FACTORY_CREATION_FAILED' })
    expect(registry.snapshot().factories[0]?.circuit.status).toBe('open')

    await vi.advanceTimersByTimeAsync(100)
    const controller = new AbortController()
    const probe = registry.create(
      ALPHA_FACTORY,
      { value: 2 },
      { signal: controller.signal },
    )
    await probeStarted.promise
    expect(registry.snapshot().factories[0]?.circuit.status).toBe('half-open')

    controller.abort('operator cancelled the probe')
    await expect(probe).rejects.toMatchObject({ code: 'ABORTED' })

    // The abort says nothing about factory health: back to open, and the
    // next creation is admitted as a fresh probe without another reset wait.
    expect(registry.snapshot().factories[0]?.circuit.status).toBe('open')
    await expect(registry.create(ALPHA_FACTORY, { value: 3 })).resolves.toEqual(
      { doubled: 6, kind: 'alpha' },
    )
    expect(registry.snapshot().factories[0]?.circuit).toEqual({
      consecutiveFailures: 0,
      status: 'closed',
    })
  })

  it('reclaims leaked bulkhead slots through resetConcurrency', async () => {
    vi.useFakeTimers()
    const gate = deferred<AlphaResult>()
    let calls = 0
    const registry = createTestRegistry({
      creationTimeoutMs: 20,
      maxConcurrentCreations: 1,
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory((context) => {
            calls += 1
            return calls === 1
              ? gate.promise
              : { doubled: context.value * 2, kind: 'alpha' }
          }),
        })),
      ],
    })

    const hung = registry.create(ALPHA_FACTORY, { value: 1 })
    const timeoutAssertion = expect(hung).rejects.toMatchObject({
      code: 'FACTORY_CREATION_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(20)
    await timeoutAssertion

    await expect(
      registry.create(ALPHA_FACTORY, { value: 2 }),
    ).rejects.toMatchObject({ code: 'FACTORY_BUSY' })

    registry.resetConcurrency(ALPHA_FACTORY)
    await expect(registry.create(ALPHA_FACTORY, { value: 2 })).resolves.toEqual(
      { doubled: 4, kind: 'alpha' },
    )

    // The abandoned work settling later must not drive the counter negative.
    gate.resolve({ doubled: 2, kind: 'alpha' })
    await vi.advanceTimersByTimeAsync(0)
    expect(registry.snapshot().factories[0]?.activeCreations).toBe(0)
  })

  it('returns a typed failure from tryCreate and does not throw', async () => {
    const registry = createTestRegistry({
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(() => {
            throw new Error('manufacturing failed')
          }),
        })),
      ],
    })

    const attempt = await registry.tryCreate(ALPHA_FACTORY, { value: 1 })

    expect(attempt).toMatchObject({
      error: { code: 'FACTORY_CREATION_FAILED' },
      ok: false,
    })
    if (attempt.ok) {
      expectTypeOf(attempt.value).toEqualTypeOf<AlphaResult>()
    }
  })

  it('preloads independently and reports a diagnostic snapshot', async () => {
    const registry = createTestRegistry({
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(),
        })),
        source(BETA_FACTORY, 'beta', async () => {
          throw new Error('missing chunk')
        }),
      ],
    })

    const report = await registry.preload()

    expect(report.loaded).toEqual([ALPHA_FACTORY])
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]).toMatchObject({
      error: { code: 'MODULE_LOAD_FAILED' },
      key: BETA_FACTORY,
    })
    expect(registry.snapshot()).toEqual({
      factories: [
        {
          activeCreations: 0,
          aliases: [],
          circuit: { consecutiveFailures: 0, status: 'closed' },
          key: ALPHA_FACTORY,
          modulePath: './fixtures/alpha.factory.ts',
          status: 'ready',
        },
        {
          activeCreations: 0,
          aliases: [],
          circuit: { consecutiveFailures: 0, status: 'closed' },
          errorCode: 'MODULE_LOAD_FAILED',
          key: BETA_FACTORY,
          modulePath: './fixtures/beta.factory.ts',
          status: 'failed',
        },
      ],
    })
  })

  it('rejects an already-aborted request without loading its module', async () => {
    const controller = new AbortController()
    controller.abort('cancelled by test')
    const load = vi.fn(async () => ({ default: alphaFactory() }))
    const registry = createTestRegistry({
      sources: [source(ALPHA_FACTORY, 'alpha', load)],
    })

    await expect(
      registry.create(
        ALPHA_FACTORY,
        { value: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(load).not.toHaveBeenCalled()
  })

  it('rejects promptly when the caller aborts during module load', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const registry = createTestRegistry({
      sources: [
        source(
          ALPHA_FACTORY,
          'alpha',
          () => new Promise<CatalogFactoryModule<TestCatalog>>(() => {}),
        ),
      ],
    })

    const creation = registry.create(
      ALPHA_FACTORY,
      { value: 1 },
      { signal: controller.signal },
    )
    // Flush microtasks so the creation is awaiting the hung module load.
    await vi.advanceTimersByTimeAsync(0)
    controller.abort('cancelled mid-load')

    await expect(creation).rejects.toMatchObject({ code: 'ABORTED' })
    // The shared load continues for other callers instead of being cancelled.
    expect(registry.snapshot().factories[0]?.status).toBe('loading')
  })
})

describe('import.meta.glob adapters', () => {
  it('keeps typed loaders and maps filenames without importing modules', () => {
    const alphaLoad = vi.fn(async () => ({ default: alphaFactory() }))
    const betaLoad = vi.fn(async () => ({ default: betaFactory() }))
    const modules = {
      './fixtures/beta.factory.ts': betaLoad,
      './fixtures/alpha.factory.ts': alphaLoad,
    } satisfies GlobLoaderMap<CatalogFactoryModule<TestCatalog>>
    const keyFromPath = createFilenameKeyResolver({
      alpha: ALPHA_FACTORY,
      beta: BETA_FACTORY,
    })

    const sources = createGlobFactorySources<TestCatalog>(modules, {
      keyFromPath,
    })

    expect(sources.map(({ key }) => key)).toEqual([
      ALPHA_FACTORY,
      BETA_FACTORY,
    ])
    expectTypeOf(sources[0]?.load).returns.resolves.toEqualTypeOf<
      CatalogFactoryModule<TestCatalog>
    >()
    expect(alphaLoad).not.toHaveBeenCalled()
    expect(betaLoad).not.toHaveBeenCalled()
  })

  it('fails fast when a filename is not in the explicit key map', () => {
    const keyFromPath = createFilenameKeyResolver({ alpha: ALPHA_FACTORY })
    const modules = {
      './fixtures/unknown.factory.ts': async () => ({
        default: alphaFactory(),
      }),
    } satisfies GlobLoaderMap<CatalogFactoryModule<TestCatalog>>

    expect(() =>
      createGlobFactorySources<TestCatalog>(modules, { keyFromPath }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE' }))
  })

  it('rejects an unexpectedly empty glob by default', () => {
    expect(() =>
      createGlobFactorySources<TestCatalog>({}, {
        keyFromPath: () => ALPHA_FACTORY,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE' }))
  })
})

describe('registry events', () => {
  it('pushes lifecycle transitions that snapshot polling cannot observe', async () => {
    vi.useFakeTimers()
    const events: FactoryRegistryEvent[] = []
    let attempts = 0
    const registry = createTestRegistry({
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 100 },
      onEvent: (event) => events.push(event),
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory((context) => {
            attempts += 1
            if (attempts === 1) {
              throw new Error('transient failure')
            }
            return { doubled: context.value * 2, kind: 'alpha' }
          }),
        })),
      ],
    })

    await expect(
      registry.create(ALPHA_FACTORY, { value: 1 }, { correlationId: 'req-1' }),
    ).rejects.toMatchObject({ code: 'FACTORY_CREATION_FAILED' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(
      registry.create(ALPHA_FACTORY, { value: 2 }, { correlationId: 'req-2' }),
    ).resolves.toEqual({ doubled: 4, kind: 'alpha' })

    // The gap events close: polling after the fact reports a healthy
    // factory — the incident that just happened is invisible to snapshot().
    expect(registry.snapshot().factories[0]?.circuit).toEqual({
      consecutiveFailures: 0,
      status: 'closed',
    })

    // The event stream captured the whole incident, with request correlation.
    expect(events).toEqual([
      { key: ALPHA_FACTORY, type: 'factory-loaded' },
      { consecutiveFailures: 1, key: ALPHA_FACTORY, type: 'circuit-opened' },
      {
        code: 'FACTORY_CREATION_FAILED',
        correlationId: 'req-1',
        key: ALPHA_FACTORY,
        type: 'creation-failed',
      },
      { key: ALPHA_FACTORY, type: 'circuit-probed' },
      { key: ALPHA_FACTORY, type: 'circuit-closed' },
      { correlationId: 'req-2', key: ALPHA_FACTORY, type: 'creation-succeeded' },
    ])

    registry.invalidate(ALPHA_FACTORY)
    registry.resetCircuit(ALPHA_FACTORY)
    registry.resetConcurrency(ALPHA_FACTORY)
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      'factory-invalidated',
      'circuit-reset',
      'concurrency-reset',
    ])
  })

  it('keeps creating products when an event listener throws', async () => {
    const registry = createTestRegistry({
      onEvent: () => {
        throw new Error('broken telemetry pipeline')
      },
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(),
        })),
      ],
    })

    await expect(registry.create(ALPHA_FACTORY, { value: 2 })).resolves.toEqual(
      { doubled: 4, kind: 'alpha' },
    )
  })
})

describe('per-factory policy overrides', () => {
  function hungAlphaSource() {
    return source(ALPHA_FACTORY, 'alpha', async () => ({
      default: alphaFactory(() => new Promise<AlphaResult>(() => {})),
    }))
  }

  function slowBetaSource() {
    return source(BETA_FACTORY, 'beta', async () => ({
      default: defineTestFactory(BETA_FACTORY)({
        create: (context) =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ kind: 'beta', uppercased: context.text.toUpperCase() })
            }, 100)
          }),
        metadata: { displayName: 'Slow Beta Factory', version: '1.0.0' },
      }),
    }))
  }

  it('exposes the shared-budget conflict: one registry-wide timeout cannot fit both factories', async () => {
    vi.useFakeTimers()
    // The only budget tight enough to bound hung alpha work (50ms) also
    // kills beta's legitimate 100ms work — collateral damage.
    const shared = createTestRegistry({
      creationTimeoutMs: 50,
      sources: [hungAlphaSource(), slowBetaSource()],
    })

    const beta = shared.create(BETA_FACTORY, { text: 'hi' })
    const betaAssertion = expect(beta).rejects.toMatchObject({
      code: 'FACTORY_CREATION_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(100)
    await betaAssertion
  })

  it('resolves the conflict: each factory runs under its own policy', async () => {
    vi.useFakeTimers()
    const tuned = createTestRegistry({
      creationTimeoutMs: 1_000,
      policies: {
        [ALPHA_FACTORY]: {
          circuitBreaker: { failureThreshold: 1 },
          creationTimeoutMs: 50,
          maxConcurrentCreations: 1,
        },
      },
      sources: [hungAlphaSource(), slowBetaSource()],
    })

    const beta = tuned.create(BETA_FACTORY, { text: 'hi' })
    const alpha = tuned.create(ALPHA_FACTORY, { value: 1 })
    const alphaAssertion = expect(alpha).rejects.toMatchObject({
      code: 'FACTORY_CREATION_TIMEOUT',
    })

    // Alpha times out at its own 50ms budget, not the registry-wide 1000ms.
    await vi.advanceTimersByTimeAsync(50)
    await alphaAssertion

    // Alpha's tighter bulkhead (1 slot, still held by the hung work) and
    // circuit (threshold 1) reflect alpha's policy alone.
    await expect(
      tuned.create(ALPHA_FACTORY, { value: 2 }),
    ).rejects.toMatchObject({ code: 'FACTORY_BUSY' })
    expect(tuned.snapshot().factories[0]?.circuit.status).toBe('open')

    // Beta is untouched: registry-wide defaults let its 100ms work finish.
    await vi.advanceTimersByTimeAsync(50)
    await expect(beta).resolves.toEqual({ kind: 'beta', uppercased: 'HI' })
    expect(tuned.snapshot().factories[1]?.circuit.status).toBe('closed')
  })

  it('fails closed on invalid or unknown policy overrides', () => {
    expect(() =>
      createTestRegistry({
        policies: { [ALPHA_FACTORY]: { creationTimeoutMs: 0 } },
        sources: [hungAlphaSource()],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY' }))

    expect(() =>
      createTestRegistry({
        policies: { 'test:ghost': { creationTimeoutMs: 10 } } as never,
        sources: [hungAlphaSource()],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY' }))
  })
})

describe('type-level guarantees', () => {
  it('rejects colon-less key literals at compile time and at runtime', () => {
    // @ts-expect-error - factory keys require a "namespace:name" literal
    expect(() => factoryKey('missing-colon')).toThrowError()
    // @ts-expect-error - aliases share the same literal constraint
    expect(() => factoryAlias('missing-colon')).toThrowError()
  })

  it('composes namespaced keys so the format cannot be mistyped', () => {
    const testing = factoryNamespace('testing')
    const key = testing.key('gamma')
    const alias = testing.alias('legacy-gamma')

    // The colon is composed by the builder, never typed by hand, and the
    // exact branded literal is inferred from the parts.
    expect(key).toBe('testing:gamma')
    expect(alias).toBe('testing:legacy-gamma')
    expectTypeOf(key).toEqualTypeOf<FactoryKey<'testing:gamma'>>()
    expectTypeOf(alias).toEqualTypeOf<FactoryAlias<'testing:legacy-gamma'>>()

    // @ts-expect-error - segments must be lowercase
    expect(() => testing.key('Gamma')).toThrowError()
    // @ts-expect-error - segments cannot contain a colon
    expect(() => testing.key('extra:gamma')).toThrowError()
    // @ts-expect-error - segments cannot contain spaces
    expect(() => testing.key('pass enger')).toThrowError()
    // @ts-expect-error - namespaces are screened and validated eagerly
    expect(() => factoryNamespace('Test_Ing')).toThrowError()
  })

  it('derives a closed vocabulary so undeclared names fail at compile time', () => {
    const keys = factoryKeySet('closed', ['gamma', 'delta'])
    const aliases = factoryAliasSet('closed', ['legacy'])

    // The vocabulary is declared once; the branded values and their exact
    // literal types are both derived from that single declaration.
    expect(keys.gamma).toBe('closed:gamma')
    expect(aliases.legacy).toBe('closed:legacy')
    expectTypeOf(keys.gamma).toEqualTypeOf<FactoryKey<'closed:gamma'>>()
    expectTypeOf(keys.delta).toEqualTypeOf<FactoryKey<'closed:delta'>>()
    expectTypeOf(aliases.legacy).toEqualTypeOf<
      FactoryAlias<'closed:legacy'>
    >()

    // @ts-expect-error - 'gamma2' was never declared in the vocabulary
    void keys.gamma2
    // @ts-expect-error - undeclared aliases are property-access errors too
    void aliases.modern

    expect(() => factoryKeySet('closed', ['dup', 'dup'])).toThrowError()
    // @ts-expect-error - segment screening applies to every declared name
    expect(() => factoryKeySet('closed', ['Bad Name'])).toThrowError()
  })

  it('narrows diagnostic keys to the catalog key union', async () => {
    const registry = createTestRegistry({
      onEvent: (event) => {
        expectTypeOf(event.key).toEqualTypeOf<
          typeof ALPHA_FACTORY | typeof BETA_FACTORY
        >()
      },
      sources: [
        source(ALPHA_FACTORY, 'alpha', async () => ({
          default: alphaFactory(),
        })),
      ],
    })

    await registry.create(ALPHA_FACTORY, { value: 1 })

    const snapshotKey = registry.snapshot().factories[0]?.key
    expectTypeOf(snapshotKey).toEqualTypeOf<
      typeof ALPHA_FACTORY | typeof BETA_FACTORY | undefined
    >()
  })
})

describe('public API surface', () => {
  it('exposes exactly the curated runtime exports', () => {
    // This list is the library's public contract. A failure here means an
    // export was added or removed without a deliberate decision — exactly
    // the accidental breaking change the curated index prevents.
    expect([...Object.keys(publicApi)].sort()).toEqual([
      'FACTORY_REGISTRY_ERROR_CODES',
      'FactoryRegistryError',
      'SmartFactoryRegistry',
      'createFilenameKeyResolver',
      'createGlobFactorySources',
      'defineFactoryCatalog',
      'defineFactoryFor',
      'factoryAlias',
      'factoryAliasSet',
      'factoryCatalogEntry',
      'factoryContract',
      'factoryHarnessFor',
      'factoryKey',
      'factoryKeySet',
      'factoryNamespace',
      'isFactoryAlias',
      'isFactoryKey',
      'isFactoryRegistryError',
      'modulePath',
      'smartFactoryRegistryFor',
    ])
  })

  it('keeps implementation details private', () => {
    // Before curation, `export *` leaked these; consumers importing them
    // would have frozen internal helpers into the public contract.
    expect(publicApi).not.toHaveProperty('normalizeFactoryRegistryError')
    expect(publicApi).not.toHaveProperty('factoryKeySchema')
    expect(publicApi).not.toHaveProperty('factoryAliasSchema')
    expect(publicApi).not.toHaveProperty('modulePathSchema')
  })
})
