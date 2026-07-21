# Adding a Domain to the Factory Kernel

A step-by-step implementation guide for wiring a new consumer domain (like
`aircraft` or `report`) onto `src/factory-core/`. It walks a worked example —
a `beverage` domain with `espresso` and `smoothie` factories — from empty
directory to green `npm run verify`.

Companion document: [factory-kernel.md](factory-kernel.md) explains *why* the
kernel behaves the way it does; this guide covers *how* to consume it.

---

## Table of contents

- [1. What you build and what you never touch](#1-what-you-build-and-what-you-never-touch)
- [2. How the pieces fit together](#2-how-the-pieces-fit-together)
- [3. Conventions the tooling enforces](#3-conventions-the-tooling-enforces)
- [4. Step 1 — Scaffold the directory and factory stubs](#4-step-1--scaffold-the-directory-and-factory-stubs)
- [5. Step 2 — Generate the vocabulary](#5-step-2--generate-the-vocabulary)
- [6. Step 3 — Write the catalog](#6-step-3--write-the-catalog)
- [7. Step 4 — Complete the factory modules](#7-step-4--complete-the-factory-modules)
- [8. Step 5 — Write the composition root](#8-step-5--write-the-composition-root)
- [9. Step 6 — Write the barrel](#9-step-6--write-the-barrel)
- [10. Step 7 — Write the tests](#10-step-7--write-the-tests)
- [11. Step 8 — Run the gates](#11-step-8--run-the-gates)
- [12. Using the domain](#12-using-the-domain)
- [13. Optional wiring: aliases, policies, telemetry](#13-optional-wiring-aliases-policies-telemetry)
- [14. Naming conventions](#14-naming-conventions)
- [15. Troubleshooting](#15-troubleshooting)
- [16. Checklist](#16-checklist)

---

## 1. What you build and what you never touch

A domain is exactly four kinds of files, all under `src/<domain>/`:

| File | Role | Beverage example |
| --- | --- | --- |
| `factories/<name>.factory.ts` | One independently loadable factory per product | `espresso.factory.ts`, `smoothie.factory.ts` |
| `catalog.ts` | Zod schemas, contracts, the domain's vocabulary exports | build orders in, drinks out |
| `registry.ts` | Composition root: the literal `import.meta.glob` + `factoryDomainFor` | ~25 lines |
| `index.ts` | Curated barrel + the domain's error contract | 2 export lines + doc |

Plus a test file (`registry.test.ts`) beside them.

**You never touch anything else.** Adding a domain requires zero edits to
`src/factory-core/`, zero edits to other domains, zero edits to
`scripts/generate-factory-set.mjs`, and there is no central registration list
anywhere. The generator discovers your domain by scanning the filesystem, and
the kernel is consumed exclusively through its barrel
(`import { ... } from '../factory-core'`). If you find yourself wanting to
change the kernel to fit your domain, stop — that is the architectural
violation the whole design exists to prevent.

The fastest path in practice is to copy `src/report/` (the smaller of the two
proof domains) and rename. This guide builds from scratch instead so every
line is explained.

## 2. How the pieces fit together

```
src/beverage/factories/espresso.factory.ts   "I am beverage:espresso, I produce 'hot'"
                    │
                    │ scanned by scripts/generate-factory-set.mjs
                    ▼
src/generated/factory-set.generated.ts       factorySet.beverage.espresso (branded key)
                    │                        productTypeSet.beverage.hot
                    │ imported by            factoryDefinitionSet.beverage.espresso (pairing)
                    ▼
src/beverage/catalog.ts                      schemas + contracts keyed by generated keys
                    │
                    │ imported by
                    ▼
src/beverage/registry.ts                     literal glob + factoryDomainFor(catalog)
                    │
                    ▼
src/beverage/index.ts                        public surface
```

The flow to remember: **filenames are the source of truth**. The generator
turns filenames into branded keys and pairs them with each file's declared
product type; the catalog attaches schemas to those keys; the composition
root discovers the same files again at runtime through the glob and maps them
back to the same keys by filename stem. Drift between any two of these layers
fails at composition time or codegen time, not in production.

## 3. Conventions the tooling enforces

These are hard requirements, checked by the generator, the kernel, or both:

1. **Directory layout**: factories live in `src/<domain>/factories/` and end
   in `.factory.ts`. The glob in `registry.ts` is non-recursive — a factory
   moved into a subdirectory drops out of discovery (the harness will then
   fail composition with an uncovered-key error rather than letting it slide).
2. **Kebab-case, lowercase segments**: the domain directory name and every
   filename stem must match `[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*`. `ColdBrew` or
   `cold_brew` fail codegen; `cold-brew` is fine.
3. **Filename stem = key name**: `espresso.factory.ts` becomes the key
   `beverage:espresso`. The runtime resolver derives this same mapping from
   the catalog's key names, so renaming a file without renaming everything
   else fails loudly at composition time.
4. **The product type declaration is literal.** Every factory file must
   contain exactly one line of this exact syntactic form:

   ```ts
   export const productType = factoryProductType('hot')
   ```

   The generator parses it with a regex, not the TypeScript compiler. A
   computed value, a renamed constant, or a re-export breaks discovery with a
   clear error. Product types are lowercase kebab-case segments too.
5. **Factories must be built with `defineFactoryFor`.** The registry's module
   boundary schema requires the attestation marker it stamps; a hand-rolled
   default export is rejected at load with `INVALID_FACTORY_MODULE`.
6. **Metadata is validated eagerly**: `displayName` non-blank, `version` real
   semver. Bad metadata throws where the factory is written.

## 4. Step 1 — Scaffold the directory and factory stubs

Create the layout:

```
src/beverage/
  factories/
    espresso.factory.ts
    smoothie.factory.ts
  catalog.ts        (empty for now)
  registry.ts       (empty for now)
  index.ts          (empty for now)
```

There is a deliberate bootstrap order here: the catalog imports the generated
vocabulary, but the generator needs the factory files to exist first. The
generator only *reads text* — it never compiles — so a stub containing just
the product type declaration is enough to bootstrap:

```ts
// src/beverage/factories/espresso.factory.ts (stub — completed in Step 4)
import { factoryProductType } from '../../factory-core'

export const productType = factoryProductType('hot')
```

```ts
// src/beverage/factories/smoothie.factory.ts (stub — completed in Step 4)
import { factoryProductType } from '../../factory-core'

export const productType = factoryProductType('iced')
```

Note the split: the *key* names the factory (`espresso` — the process); the
*product type* names what it makes (`hot` — the output category). They are
different vocabularies. Aircraft pairs `passenger → airliner`; report pairs
`print → pdf`.

## 5. Step 2 — Generate the vocabulary

```
npm run generate:factories
```

(You rarely run this by hand — `predev`, `prebuild`, `pretest`, and
`pretypecheck` hooks all regenerate automatically, and `npm run verify` runs
`codegen:check` to catch a stale artifact.)

`src/generated/factory-set.generated.ts` now contains a `beverage` namespace
in all three trees:

```ts
factorySet.beverage            // { espresso: FactoryKey<'beverage:espresso'>, smoothie: ... }
productTypeSet.beverage        // { hot: 'hot', iced: 'iced' }
factoryDefinitionSet.beverage  // { espresso: { key, productType: 'hot' }, ... }
```

Everything downstream is compiler-checked against these:
`factorySet.beverage.espresso2` is a property-access error, not a typo that
survives to runtime. Do not hand-edit the generated file; change a factory
file and regenerate.

## 6. Step 3 — Write the catalog

The catalog owns the part that cannot be inferred from filenames: the
domain's *meaning* — context schemas (what callers must supply), result
schemas (what factories must produce), and the discriminator property.

```ts
// src/beverage/catalog.ts
import { z } from 'zod'
import {
  factoryDefinitionSet,
  factorySet,
  productTypeSet,
} from '../generated/factory-set.generated'
import {
  defineFactoryCatalog,
  defineFactoryFor,
  factoryCatalogEntry,
  factoryContract,
} from '../factory-core'

// Canonical keys are generated from *.factory.ts filenames. Every other
// mention is compiler-checked; an undiscovered name cannot compile.
const beverageFactories = factoryDefinitionSet.beverage
export const beverageType = productTypeSet.beverage

// Only the beverage slice of the generated vocabulary is part of this
// domain's surface; other domains import the generated module directly.
export const beverageFactorySet = factorySet.beverage
export const beverageFactoryDefinitionSet = beverageFactories

export const ESPRESSO_BEVERAGE_FACTORY = beverageFactories.espresso.key
export const SMOOTHIE_BEVERAGE_FACTORY = beverageFactories.smoothie.key

// ── Context schemas: what callers pass to create() ──────────────────────────
export const ESPRESSO_ORDER_SCHEMA = z
  .strictObject({
    shots: z.number().int().min(1).max(4),
  })
  .readonly()

export const SMOOTHIE_ORDER_SCHEMA = z
  .strictObject({
    fruits: z.array(z.string().min(1)).min(1).readonly(),
  })
  .readonly()

// ── Result schemas: what factories must produce ─────────────────────────────
// Each result branch must carry the exact product literal at the
// discriminator property — factoryContract enforces this at compile time,
// and the registry re-checks it at runtime after parsing.
export const HOT_BEVERAGE_SCHEMA = z
  .strictObject({
    category: z.literal(beverageType.hot),
    shots: z.number().int().positive(),
    volumeMl: z.number().positive(),
  })
  .readonly()

export const ICED_BEVERAGE_SCHEMA = z
  .strictObject({
    category: z.literal(beverageType.iced),
    fruitCount: z.number().int().positive(),
    volumeMl: z.number().positive(),
  })
  .readonly()

export const BEVERAGE_SCHEMA = z.discriminatedUnion('category', [
  HOT_BEVERAGE_SCHEMA,
  ICED_BEVERAGE_SCHEMA,
])

export type EspressoOrder = z.output<typeof ESPRESSO_ORDER_SCHEMA>
export type SmoothieOrder = z.output<typeof SMOOTHIE_ORDER_SCHEMA>
export type HotBeverage = z.output<typeof HOT_BEVERAGE_SCHEMA>
export type IcedBeverage = z.output<typeof ICED_BEVERAGE_SCHEMA>
export type Beverage = z.output<typeof BEVERAGE_SCHEMA>

// ── Contracts: key → (context in, result out, discriminator, product) ───────
export const BEVERAGE_FACTORY_CATALOG = defineFactoryCatalog({
  ...factoryCatalogEntry(
    ESPRESSO_BEVERAGE_FACTORY,
    factoryContract({
      contextSchema: ESPRESSO_ORDER_SCHEMA,
      discriminator: 'category',
      productType: beverageFactories.espresso.productType,
      resultSchema: HOT_BEVERAGE_SCHEMA,
    }),
  ),
  ...factoryCatalogEntry(
    SMOOTHIE_BEVERAGE_FACTORY,
    factoryContract({
      contextSchema: SMOOTHIE_ORDER_SCHEMA,
      discriminator: 'category',
      productType: beverageFactories.smoothie.productType,
      resultSchema: ICED_BEVERAGE_SCHEMA,
    }),
  ),
})

export type BeverageFactoryCatalog = typeof BEVERAGE_FACTORY_CATALOG

/** Curried once for the domain; factory modules import this instead of re-deriving it. */
export const defineBeverageFactory = defineFactoryFor<BeverageFactoryCatalog>()
```

Decisions this file makes, and their rules:

- **The discriminator is yours to choose.** Aircraft uses `type`, report uses
  `format`, this example uses `category`. It must be a plain identifier and
  every result branch must carry the exact product literal there — wiring
  `resultSchema: ICED_BEVERAGE_SCHEMA` onto the espresso contract is a
  compile error, not a runtime surprise.
- **Take `productType` from `factoryDefinitionSet`**, never a string literal.
  The generated pairing is what keeps the catalog honest with the factory
  files.
- **Prefer `strictObject().readonly()`** so unknown fields are rejected (this
  is what makes "airliner-only fields in a freighter order" a caller error)
  and outputs are immutable-typed.
- **Branded domain IDs** are an optional pattern worth copying when you have
  them — see `AircraftOrderId` in [src/aircraft/catalog.ts](../src/aircraft/catalog.ts)
  for a `Brand` + `z.custom` validator + constructor triple.

## 7. Step 4 — Complete the factory modules

Now that the catalog exists, complete the stubs. A factory module is: the
product type declaration, plus a default export built with the domain's
currier.

```ts
// src/beverage/factories/espresso.factory.ts
import { factoryProductType } from '../../factory-core'
import { ESPRESSO_BEVERAGE_FACTORY, defineBeverageFactory } from '../catalog'

export const productType = factoryProductType('hot')

export default defineBeverageFactory(ESPRESSO_BEVERAGE_FACTORY)({
  metadata: {
    description: 'Pulls an espresso-based hot beverage.',
    displayName: 'Espresso Beverage Factory',
    version: '1.0.0',
  },
  productType,
  create(order, options) {
    options?.signal?.throwIfAborted()

    return Object.freeze({
      category: productType,
      shots: order.shots,
      volumeMl: order.shots * 30,
    })
  },
})
```

```ts
// src/beverage/factories/smoothie.factory.ts
import { factoryProductType } from '../../factory-core'
import { SMOOTHIE_BEVERAGE_FACTORY, defineBeverageFactory } from '../catalog'

export const productType = factoryProductType('iced')

export default defineBeverageFactory(SMOOTHIE_BEVERAGE_FACTORY)({
  metadata: {
    description: 'Blends fruit into an iced beverage.',
    displayName: 'Smoothie Beverage Factory',
    version: '1.0.0',
  },
  productType,
  create(order, options) {
    options?.signal?.throwIfAborted()

    return Object.freeze({
      category: productType,
      fruitCount: order.fruits.length,
      volumeMl: 400,
    })
  },
})
```

What you get for free here:

- **`order` is fully typed** (`EspressoOrder`) with zero annotations —
  `defineBeverageFactory(KEY)` contextually types `create` against that key's
  real contract, so writing this factory against the wrong shape is an editor
  error in this file.
- **`order` is already validated.** The registry parses the caller's context
  before your `create` runs; you never defend against malformed input.
- **Your result is validated after you return it** (schema + discriminator
  re-check), so a bug here fails closed as `INVALID_FACTORY_RESULT`.
- **`options?.signal`** is the registry-owned deadline/abort signal. Check it
  at the top and at natural pause points in long-running work; `timeoutMs` is
  the *total* budget, not remaining time — the signal is authoritative.
- **Do not rely on `this`** inside `create` — the registry rebinds it. The
  delegation in `defineFactoryFor` keeps class-based implementations working,
  but the contract is `this: void`.

Async factories are fine: `create` may return a value or a promise.

## 8. Step 5 — Write the composition root

```ts
// src/beverage/registry.ts
import { factoryDomainFor, type CatalogFactoryModule } from '../factory-core'
import {
  BEVERAGE_FACTORY_CATALOG,
  type BeverageFactoryCatalog,
} from './catalog'

type BeverageFactoryModule = CatalogFactoryModule<BeverageFactoryCatalog>

// Vite requires this literal glob at the composition root so it can transform it.
// The <BeverageFactoryModule> type argument is an unchecked assertion — Vite
// cannot verify it — but factory-core's module boundary schema re-validates
// every loaded module at runtime, so a module that lies about this type is
// rejected at load rather than trusted.
const beverageFactoryModules = import.meta.glob<BeverageFactoryModule>(
  './factories/*.factory.ts',
)

const domain = factoryDomainFor(BEVERAGE_FACTORY_CATALOG)

export function createBeverageFactoryRegistry() {
  return domain.createRegistry(beverageFactoryModules)
}

/**
 * Lazily memoized shared registry. Nothing is constructed at import time, so
 * importing the barrel for a type or an order schema stays side-effect-free,
 * and a composition failure (empty glob, unmapped stem) surfaces at the
 * first call instead of during module evaluation.
 */
export const getBeverageFactoryRegistry = domain.lazyRegistry(
  beverageFactoryModules,
)
```

Rules that make this file what it is:

- **The glob pattern must be a static string literal, written here.** Vite
  transforms `import.meta.glob` at build time; a computed pattern or one
  hoisted into the kernel silently breaks. This is the one piece of the
  pattern that can never be extracted.
- **No keys-by-file map is needed.** `factoryDomainFor` derives the
  filename→key resolver from the catalog's own key names (`beverage:espresso`
  → stem `espresso`). If your filenames ever deviate from key names, pass an
  explicit `keyFromPath` in the options instead.
- **Composition fails fast and completely.** At the first
  `createBeverageFactoryRegistry()` call, the kernel validates the glob is
  non-empty, every file maps to a catalog key, no duplicates, and — the other
  direction — every catalog key received a discovered module. A factory file
  accidentally moved out of the glob's reach is a composition error, not a
  runtime `UNKNOWN_FACTORY` months later.
- **Export both builders.** `create...` for tests and callers who want an
  isolated instance; `get...` as the shared lazily-built singleton.

## 9. Step 6 — Write the barrel

```ts
// src/beverage/index.ts
/**
 * Public surface of the beverage domain.
 *
 * Error contract: factory-core failures pass through untranslated. Callers
 * observe FactoryRegistryError with its stable `code` values (for example
 * INVALID_FACTORY_CONTEXT for a rejected order) rather than a
 * beverage-specific error vocabulary. This pass-through is a deliberate
 * decision, not an accident: the domain is a thin composition root over
 * factory-core, and the registry's codes are the supported way to branch on
 * failure.
 */
export * from './catalog'
export * from './registry'
```

The error-contract comment is not decoration — it records a decision. If your
domain instead wants to translate registry errors into its own vocabulary,
that is a legitimate choice too; make it explicitly and document it here.

## 10. Step 7 — Write the tests

Model on [src/aircraft/registry.test.ts](../src/aircraft/registry.test.ts).
The minimum worth having, and what each one actually guards:

```ts
// src/beverage/registry.test.ts
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ESPRESSO_BEVERAGE_FACTORY,
  SMOOTHIE_BEVERAGE_FACTORY,
  beverageFactorySet,
  beverageType,
  type Beverage,
  type HotBeverage,
  type IcedBeverage,
} from './catalog'
import {
  createBeverageFactoryRegistry,
  getBeverageFactoryRegistry,
} from './registry'

describe('beverage factory composition root', () => {
  it('discovers both modules lazily through the literal Vite glob', () => {
    const registry = createBeverageFactoryRegistry()

    expect(registry.snapshot()).toEqual({
      factories: [
        {
          activeCreations: 0,
          aliases: [],
          circuit: { consecutiveFailures: 0, status: 'closed' },
          key: ESPRESSO_BEVERAGE_FACTORY,
          modulePath: expect.stringContaining('espresso.factory.ts'),
          status: 'idle',
        },
        {
          activeCreations: 0,
          aliases: [],
          circuit: { consecutiveFailures: 0, status: 'closed' },
          key: SMOOTHIE_BEVERAGE_FACTORY,
          modulePath: expect.stringContaining('smoothie.factory.ts'),
          status: 'idle',
        },
      ],
    })
  })

  it('memoizes the shared registry behind a lazy accessor', () => {
    expect(getBeverageFactoryRegistry()).toBe(getBeverageFactoryRegistry())
  })

  it('creates distinct, strongly inferred products', async () => {
    const registry = createBeverageFactoryRegistry()

    const hot = await registry.create(beverageFactorySet.espresso, {
      shots: 2,
    })
    const iced = await registry.create(beverageFactorySet.smoothie, {
      fruits: ['mango', 'banana'],
    })

    expect(hot).toEqual({ category: 'hot', shots: 2, volumeMl: 60 })
    expect(iced).toEqual({ category: 'iced', fruitCount: 2, volumeMl: 400 })
    expectTypeOf(hot).toEqualTypeOf<HotBeverage>()
    expectTypeOf(iced).toEqualTypeOf<IcedBeverage>()
  })

  it('narrows mixed products by the domain discriminator', async () => {
    const registry = createBeverageFactoryRegistry()
    const drinks: Beverage[] = [
      await registry.create(beverageFactorySet.espresso, { shots: 1 }),
    ]

    for (const drink of drinks) {
      if (drink.category === beverageType.hot) {
        expectTypeOf(drink).toEqualTypeOf<HotBeverage>()
        // @ts-expect-error - fruit counts do not exist on hot beverages
        void drink.fruitCount
      }
    }
  })

  it('rejects invalid orders with registry context', async () => {
    const registry = createBeverageFactoryRegistry()

    await expect(
      registry.create(ESPRESSO_BEVERAGE_FACTORY, { shots: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_FACTORY_CONTEXT' })
  })
})
```

Why these five matter:

- **The snapshot test is your drift guard.** It walks the real glob through
  the real resolver, so a stale generated artifact, a renamed file, or an
  added-but-unmapped factory fails here at composition time. Match module
  paths with `expect.stringContaining` — their exact spelling is the
  bundler's business, not your contract.
- **The memoization test** pins the lazy-accessor behavior.
- **The `expectTypeOf`/`@ts-expect-error` probes** are how the type-level
  guarantees stay executable — a claim without a test is a bug.
- **The invalid-order test** pins the domain's error contract (registry codes
  pass through).

## 11. Step 8 — Run the gates

```
npm run verify
```

This runs, in order: `codegen:check` (generated vocabulary is current),
`tsc --noEmit`, the full Vitest suite, and a production `vite build`. All
four must pass. Check the build output while you're there: each factory
should appear as its own chunk (for example
`dist/assets/espresso.factory-*.js`) — that is the lazy glob working.

## 12. Using the domain

```ts
import {
  beverageFactorySet,
  getBeverageFactoryRegistry,
} from './beverage'

const registry = getBeverageFactoryRegistry()

// Fully inferred: context is EspressoOrder input, result is HotBeverage.
const drink = await registry.create(
  beverageFactorySet.espresso,
  { shots: 2 },
  { correlationId: 'order-42' },
)
```

Also available on every registry: `tryCreate()` (typed result instead of
throw), `preload()` (warm chunks ahead of demand), `snapshot()` and operator
resets (`invalidate`, `resetCircuit`, `resetConcurrency`), and per-call
`signal`/`timeoutMs` options. See
[factory-kernel.md §4–§7](factory-kernel.md#4-the-runtime-pipeline) for the
full pipeline and operator runbook.

## 13. Optional wiring: aliases, policies, telemetry

All harness options pass through `domain.createRegistry(modules, options)` /
`domain.lazyRegistry(modules, options)`:

```ts
export const getBeverageFactoryRegistry = domain.lazyRegistry(
  beverageFactoryModules,
  {
    // Lookup synonyms — explicit, never inferred.
    aliases: { [factoryAlias('beverage:legacy-espresso')]: ESPRESSO_BEVERAGE_FACTORY },

    // Per-factory resilience overrides; unspecified factories keep defaults.
    policies: {
      [SMOOTHIE_BEVERAGE_FACTORY]: {
        creationTimeoutMs: 5_000,
        maxConcurrentCreations: 4,
      },
    },

    // Push-based operational events (loads, circuit transitions, outcomes).
    onEvent: (event) => telemetry.record(event),

    // Registry-wide knobs: creationTimeoutMs, loadTimeoutMs, circuitBreaker,
    // maxConcurrentCreations, cacheFailures, allowEmpty, keyFromPath.
  },
)
```

Everything is validated at construction and fails closed (`INVALID_POLICY`,
`INVALID_SOURCE`) — a typo in a policy key cannot silently do nothing.

## 14. Naming conventions

These are conventions from the proof domains, not kernel requirements — but
following them keeps domains interchangeable to read:

| Thing | Pattern | Beverage example |
| --- | --- | --- |
| Key constants | `<NAME>_<DOMAIN>_FACTORY` | `ESPRESSO_BEVERAGE_FACTORY` |
| Catalog | `<DOMAIN>_FACTORY_CATALOG` / `<Domain>FactoryCatalog` | `BEVERAGE_FACTORY_CATALOG` |
| Schemas | `<NAME>_..._SCHEMA` | `ESPRESSO_ORDER_SCHEMA` |
| Vocabulary slices | `<domain>FactorySet`, `<domain>Type`, `<domain>FactoryDefinitionSet` | `beverageFactorySet` |
| Currier | `define<Domain>Factory` | `defineBeverageFactory` |
| Builders | `create<Domain>FactoryRegistry`, `get<Domain>FactoryRegistry` | `createBeverageFactoryRegistry` |

## 15. Troubleshooting

Failures are designed to happen at codegen or composition time. What each
one means:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Generator: `must export const productType = factoryProductType('type-name')` | Declaration missing, computed, renamed, or duplicated — the generator regex-parses that exact form | Write the literal declaration, exactly once per file |
| Generator: `must be a lowercase kebab-case segment` | Domain directory, filename stem, or product type breaks the naming grammar | Rename to kebab-case |
| `codegen:check`: `factory-set.generated.ts is stale` | Factory files changed without regeneration (or the artifact was hand-edited) | `npm run generate:factories` (pre-hooks normally do this for you) |
| `INVALID_SOURCE`: `has no key mapping for stem "x"` | A discovered file's stem matches no catalog key — typo'd filename, or the catalog/generated vocabulary is behind | Regenerate, then make sure the catalog has an entry for the key |
| `INVALID_SOURCE`: `discovered no factory module for catalog key` | The reverse: a catalog key with no file — file deleted, renamed, or moved outside the non-recursive glob | Restore the file to `factories/`, or remove the catalog entry |
| `INVALID_SOURCE`: `Filename stem "x" is claimed by both catalog keys` | Two catalog keys share a name segment (only possible in multi-namespace catalogs) | Pass an explicit `keyFromPath` to disambiguate |
| `INVALID_SOURCE`: `does not contain a module loader ... { eager: true }` | The glob was called with `{ eager: true }` | Use a bare (lazy) `import.meta.glob` |
| `DUPLICATE_FACTORY` | Two files resolve to the same key | Remove one |
| `INVALID_FACTORY_MODULE` at first create/preload | Default export not built with `defineFactoryFor` (attestation marker missing), or invalid metadata survived to load | Build the export with the domain currier |
| `FACTORY_KEY_MISMATCH` | File registered under one key but its default export declares another — usually a copy-pasted wrong constant | Pass the matching key constant to the currier |
| `FACTORY_PRODUCT_TYPE_MISMATCH` | Module's declared product type disagrees with the contract's | Regenerate after changing a `productType` declaration; take contract product types from `factoryDefinitionSet` |
| `INVALID_FACTORY_CONTEXT` / `INVALID_FACTORY_RESULT` at runtime | Caller sent a bad order / factory produced a bad product | These are working as intended — fix the caller or the factory |

## 16. Checklist

```
[ ] src/<domain>/factories/<name>.factory.ts per product, each with the
    literal `export const productType = factoryProductType('...')`
[ ] npm run generate:factories — generated vocabulary contains the namespace
[ ] catalog.ts: slices bound + exported, key constants, context/result
    schemas (result carries the product literal at your discriminator),
    contracts via factoryContract/factoryCatalogEntry/defineFactoryCatalog,
    define<Domain>Factory currier exported
[ ] Factory default exports completed via the currier; signal checked;
    results frozen
[ ] registry.ts: literal glob + factoryDomainFor; create... and get...
    exported
[ ] index.ts: barrel + explicit error-contract decision
[ ] registry.test.ts: snapshot (stringContaining paths), memoization,
    create round-trip with expectTypeOf, discriminator narrowing,
    INVALID_FACTORY_CONTEXT
[ ] npm run verify green; factory chunks visible in the build output
[ ] Nothing in src/factory-core/, other domains, or the generator changed
```
