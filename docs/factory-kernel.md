# The Factory Kernel

A runtime-hardened, schema-validated plugin kernel for TypeScript. It provides
lazy discovery and loading of factory modules, branded identity, Zod-enforced
trust boundaries, and per-factory resilience policy (timeouts, concurrency
bulkheads, circuit breakers) — with full type inference from schema to call
site and push-based operational events.

The aircraft and report domains in `src/aircraft/` and `src/report/` are proof
implementations, not the product. The kernel is `src/factory-core/`.

---

## 1. What problem this solves

Applications that load implementation modules dynamically (plugins, feature
modules, integration adapters, tool registries) face the same four problems:

1. **Identity** — how does a string name become a trustworthy key?
2. **Trust** — a dynamically imported module is runtime data wearing a
   compile-time type; who verifies it?
3. **Inference** — can callers get precise input/output types without writing
   any annotations?
4. **Resilience** — what happens when a module hangs, fails repeatedly, or is
   flooded with requests?

The kernel answers all four with one rule: **every compile-time promise is
backed by a runtime check, and every runtime state has a defined exit.**

---

## 2. Architecture

```
┌───────────────────────────────────────────────────────────┐
│ Consumer domains (src/aircraft/ and src/report/)           │
│                                                           │
│  catalog.ts     generated vocabulary + Zod contracts     │
│  factories/     independently loadable *.factory.ts files │
│  registry.ts    composition root: literal import.meta.glob│
└──────────────────────────┬────────────────────────────────┘
                           │ depends on (never the reverse)
┌──────────────────────────▼────────────────────────────────┐
│ Kernel (src/factory-core/)                                │
│                                                           │
│  index.ts      curated public surface (pinned by test)    │
│  harness.ts    Vite adapter: glob map → registry          │
│  glob.ts       loader-map validation, filename→key        │
│  registry.ts   SmartFactoryRegistry (orchestration)       │
│  execution.ts  circuit/bulkhead/timeout engine (internal) │
│  contracts.ts  catalog, contracts, inference chain        │
│  brand.ts      branded keys/aliases/paths + validators    │
│  errors.ts     FactoryRegistryError + stable code enum    │
└───────────────────────────────────────────────────────────┘
```

Dependency facts, enforced by construction:

- The kernel imports **nothing** from any domain.
- The kernel core (`brand`, `contracts`, `errors`, `execution`, `registry`)
  depends only on Zod plus standard platform APIs (`AbortSignal`, timers). It
  runs in any JS runtime.
- The resilience machinery (circuit breaker, bulkhead, bounded execution)
  lives in `execution.ts`, an internal per-entry engine the registry
  composes. Nothing in it depends on the registry, and it is deliberately
  not part of the public surface.
- Only `glob.ts`/`harness.ts` are bundler-shaped, and even they never call
  `import.meta.glob` — Vite requires the literal glob at the consumer's
  composition root, so the kernel accepts the resulting loader map instead.
- `factoryDomainFor(catalog)` packages the composition-root pattern: it
  returns registry builders that need only the consumer's literal glob map,
  derives the filename→key resolver from the catalog's own key names (the
  convention the generator enforces; explicitly overridable), and provides a
  lazily memoized shared-registry accessor so importing a domain barrel does
  no work at module evaluation.

---

## 3. The type system

### 3.1 Branded identity (`brand.ts`)

`FactoryKey`, `FactoryAlias`, and `ModulePath` are branded strings: plain
strings at runtime, incompatible nominal types at compile time. The brand is
only as trustworthy as its validator, so every brand constructor parses:

- Keys/aliases must match `namespace:name` in lowercase kebab-case
  (`aircraft:passenger`). The Zod regex is authoritative.
- Module paths must be non-empty and free of leading/trailing whitespace.

A template-literal constraint (`FactoryLookupLiteral = `${string}:${string}``)
additionally rejects colon-less literals **at compile time** —
`factoryKey('aircraftpassenger')` is now an editor error, not a startup error.
The template literal cannot express the full kebab-case rule; runtime Zod
still owns that.

The preferred construction removes the typo surface entirely:
`factoryNamespace('aircraft')` returns a builder whose `key('passenger')` and
`alias('legacy-passenger')` compose the literal for you — the namespace is
written once, the colon is never typed, and template-literal inference produces
the exact brand (`FactoryKey<'aircraft:passenger'>`). Each segment passes a
compile-time screen (`FactoryKeySegment`) rejecting uppercase, spaces,
colons, underscores, leading digits, and separator-edged segments; the
namespace is also validated eagerly at runtime. Free-form `factoryKey()`
remains for keys arriving as data.

Product types are validated lowercase literal strings rather than brands so
they work naturally as discriminators. Every factory module exports exactly
one declaration such as
`productType = factoryProductType('airliner')`.

The generator derives three namespace trees from
`src/<namespace>/factories/*.factory.ts` into
`src/generated/factory-set.generated.ts`: filenames produce canonical keys such as
`factorySet.aircraft.passenger`, while product declarations produce values
such as `productTypeSet.aircraft.airliner`. The third tree preserves their
relationship as `factoryDefinitionSet.aircraft.passenger`. This bridges
filesystem discovery into the TypeScript language service and prevents a
catalog from manually reconnecting a factory to the wrong product type.
Generation runs before dev, build, typecheck, and tests; Vite regenerates after
factory modules are added, changed, or removed. Aliases remain explicit because
a synonym-to-target relationship cannot be inferred from either declaration.

### 3.2 The inference chain (`contracts.ts`)

A catalog maps each key to a `FactoryContract` — a validated product type, a
configurable discriminator property, and a pair of Zod schemas (context in,
result out). Everything else is derived:

```
catalog ──► FactoryCatalogKey        the union of valid keys
        ──► FactoryContextForLookup  what create() accepts   (z.input)
        ──► FactoryValidatedContext… what factories receive  (z.output)
        ──► FactoryRawResultForLookup what factories return  (z.input)
        ──► FactoryResultForLookup   what create() returns   (z.output)
```

Contracts are validated *and adopted* at definition time:
`defineFactoryCatalog` strict-parses each contract and freezes the parsed
copy, so a hand-built or getter-backed contract mutated after definition
cannot change what the registry enforces on later `create()` calls. Schemas
are recognized structurally — by the parse surface the kernel actually
invokes — rather than by `instanceof`, so a second bundled copy of Zod
(version skew, failed dedupe) does not invalidate otherwise-correct
contracts.

The input/output split matters: the caller's context is *parsed* before the
factory sees it, and the factory's raw result is *parsed* before the caller
sees it. Types model both sides of each parse. Genuine aliases also participate
fully: `CanonicalFactoryKey` resolves an alias to its target contract with zero
annotations at the call site. Product types are separate from aliases; they
describe what a factory returns rather than another name used to select it.

### 3.3 Product types and discriminated unions

The factory key selects an implementation and therefore selects its precise
input contract. A freight order cannot contain passenger-only fields because
`create(factorySet.aircraft.freight, ...)` accepts only the freight schema.

Product types solve the related output-side problem. The aircraft contracts
use the generated values as literal `type` fields, producing the union
`Aircraft = Airliner | Freighter`. A check against
`aircraftType.freighter` narrows the value to `Freighter`; its cargo fields are
available and airliner-only cabin fields are compile-time errors. The kernel
preserves each contract's exact product type but does not prescribe the
domain's result shape or discriminator property name. At contract construction,
both `z.input<ResultSchema>` and `z.output<ResultSchema>` must carry the exact
product literal at the selected property. After parsing, the registry checks
the property again so even a dishonest schema transform fails closed.

The `report` proof domain selects `format` instead of `type`, demonstrating that
the invariant belongs to the generic contract rather than the aircraft model.

### 3.4 Catalog-parameterized diagnostics

`snapshot()` returns `FactoryRegistrySnapshot<FactoryCatalogKey<Catalog>>` and
the `onEvent` listener receives `FactoryRegistryEvent<FactoryCatalogKey<…>>`:
diagnostic keys are narrowed to *your* catalog's key union, so a listener can
switch over keys exhaustively with compiler checking. The narrowing is safe by
construction — every emitted key is a registered canonical key.

### 3.5 Where types stop and runtime takes over

Inside the registry, the entries map is keyed by runtime strings, so specific
schema generics are erased at that boundary; a handful of internal casts
re-assert what the public signatures guarantee, and the adjacent Zod parses
are what make those casts true. This is the inherent cost of a heterogeneous
registry. The public surface pays none of it.

Because the `Infer*` chain has no runtime safety net of its own, the test
suite pins it with `expectTypeOf` assertions and `@ts-expect-error` probes.
Type refactors fail tests, not consumers.

### 3.6 The authoring boundary (`defineFactoryFor`)

`defineFactoryFor<Catalog>()(key)` is the blessed way to author a factory
module, and it is where three guarantees are minted:

- **Contextual signature checking.** The implementation's `create` is
  contextually typed against the key's real catalog contract, so a factory
  written against the wrong context shape is an editor error in the factory
  file itself — not a latent runtime surprise hiding behind a glob type
  assertion.
- **Eager metadata and product-type validation.** Metadata is parsed with the
  same `factoryMetadataSchema` the module boundary enforces (mirroring
  `factoryContract`'s eager parse), and `productType` is parsed with the same
  pattern schema — so a blank display name, bad version, or invalid product
  type throws where the factory is written, not at first load in production.
  `FactoryMetadata['version']` is additionally compile-screened by a semver
  template-literal type; the template cannot express the full grammar
  (integer-only segments, the prerelease/build character set), so the Zod
  schema stays authoritative — the same screen-vs-schema split as branded
  keys (§3.1).
- **Receiver preservation + attestation.** The built factory *delegates* —
  `create: (context, options) => implementation.create(context, options)` —
  rather than spreading the implementation, so prototype-held members and
  `this`-dependent class implementations keep working. The frozen result is
  stamped with the `DEFINED_FACTORY` marker
  (`Symbol.for('factory-kernel/defined-factory')`, not part of the public
  index) that the module boundary requires (§5).

`AbstractFactory.create` declares `this: void`: the registry rebinds `create`
to a synthetic frozen receiver, and the type states that contract.
Implementations that declare their `this` dependence are compile-rejected,
and `this` is unusable inside object-literal implementations. Implicit
`this` in a class method is invisible to the type system — that residual gap
is closed by delegation instead: every loadable module was built here, and
the delegating closure ignores receivers by construction.

---

## 4. The runtime pipeline

Every `create(key, context, options)` call passes through, in order:

1. **Execution options** — strict-parsed (`correlationId`, `signal`,
   `timeoutMs`); invalid options fail closed (`INVALID_EXECUTION_OPTIONS`).
2. **Abort pre-check** — an already-aborted signal rejects before any work.
3. **Key resolution** — alias → canonical key, or `UNKNOWN_FACTORY`.
4. **Context validation** — the contract's context schema parses the input
   *before the module chunk loads*. A bad request never triggers a download.
   The parse itself runs inside the same bounded envelope as the rest of the
   pipeline: it is cut off by the creation timeout and honors the caller's
   signal while in flight, so a hanging async refinement cannot stall
   `create()`. A stalled parse is treated as caller input, not factory
   health — it never moves the circuit.
5. **Module load** (lazy, cached, deduplicated) — see §5. The caller's abort
   signal is honored *during* the load: the caller rejects immediately while
   the shared load continues for others.
6. **Bulkhead admission** — per-factory concurrency slot or `FACTORY_BUSY`.
7. **Circuit admission** — closed, or an open circuit past its reset window
   admits exactly one half-open probe; otherwise `CIRCUIT_OPEN`.
8. **Execution** — the factory's `create` runs under a deadline with a
   registry-owned `AbortSignal` (linked to the caller's signal; aborted by
   the deadline).
9. **Result validation** — the contract's result schema parses the output,
   then the configured discriminator must equal the contract product type, or
   the call fails with `INVALID_FACTORY_RESULT`.
10. **Circuit accounting + event emission** — success/failure recorded,
    `creation-succeeded`/`creation-failed` emitted with correlation id.

`tryCreate()` wraps the same pipeline in a typed
`{ ok: true, value } | { ok: false, error }` result for callers who prefer
values over exceptions.

---

## 5. Module loading and the trust boundary

Loading is lazy and stateful per factory: `idle → loading → ready | failed`.

- Concurrent loads share one promise; a module is imported at most once.
- Loads run under a hard deadline (`loadTimeoutMs`, default 15s →
  `MODULE_LOAD_TIMEOUT`).
- Failures are cached (configurable via `cacheFailures`) until `invalidate()`,
  which bumps a revision counter so a stale in-flight load cannot clobber the
  reset state. In-flight creations complete against the module they started
  with.

A loaded module is **untrusted data** until proven otherwise:

1. Zod parses the module boundary: the default export must carry the
   `DEFINED_FACTORY` attestation marker that only `defineFactoryFor` stamps
   (§3.6) — machine-checkable proof that its `create` signature was
   compile-verified against the real catalog contract — plus a callable
   `create`, a pattern-valid `key` and `productType`, and semver-valid
   metadata (`INVALID_FACTORY_MODULE`). The marker refinement runs against
   the raw export, piped ahead of the object schema, because Zod's object
   parsing rebuilds values with string keys only and would drop the symbol.
   `Symbol.for` is deliberately forgeable: the marker targets accidental
   drift, not hostile code (see honest limits below).
2. The exported key must equal the registered key (`FACTORY_KEY_MISMATCH`) —
   a file cannot impersonate another factory.
3. The exported product type must equal the catalog contract's product type
   (`FACTORY_PRODUCT_TYPE_MISMATCH`).
4. The registry then captures `create` bound against a frozen receiver built
   from the validated fields. Later mutation of the module's export object
   changes nothing the registry uses (covered by a mutation-attack test).
   For a `defineFactoryFor`-built module the captured function is the
   delegating closure, which ignores receivers — so the rebinding is harmless
   and implementations keep their own `this` (§3.6).

**Honest limits** (see also README "Trust boundary"): Zod validates a module
only *after* JavaScript has imported it, so top-level module code has already
run. In-process deadlines cannot preempt an infinite synchronous loop. This
kernel hardens a boundary for trusted/semi-trusted application modules;
genuinely hostile plugins require a Worker/process boundary and a serialized
message contract — a different architecture, deliberately out of scope. The
groundwork is laid regardless: results are schema-enforced plain data, never
functions or class instances.

---

## 6. Resilience machinery

### 6.1 Bulkhead (per-factory concurrency)

Each factory has a slot budget (`maxConcurrentCreations`, default 16). Work
that times out **retains its slot until the underlying promise actually
settles** — a deliberate choice that prevents uncooperative work from
accumulating unboundedly behind a released limit. The corollary is an escape
hatch: `resetConcurrency(key)` reclaims slots leaked by work that will never
settle, and the release path floors at zero so late settlement of abandoned
work cannot corrupt the counter.

### 6.2 Circuit breaker (per-factory)

```
            failures ≥ threshold
   closed ──────────────────────────► open
     ▲                                 │ reset window elapses
     │ probe succeeds                  ▼
     └───────────────────────────── half-open ── probe fails ──► open
                                       │
                                       │ probe ends neutrally (e.g. abort)
                                       └──────► open (re-armed: next call
                                                probes immediately)
```

- Threshold and reset window default to 3 failures / 30s.
- Exactly one half-open probe is admitted; contenders get `CIRCUIT_OPEN`.
- Only factory-health failures count: `FACTORY_CREATION_FAILED`,
  `FACTORY_CREATION_TIMEOUT`, `INVALID_FACTORY_RESULT`. Caller mistakes
  (bad context, bad options) and aborts never move the circuit.
- **Neutral probe outcomes re-arm rather than wedge**: an aborted probe
  returns the circuit to `open` with its original open-time preserved, so the
  next creation is admitted as a fresh probe with no additional wait.
- Stale in-flight operations cannot corrupt state: every transition bumps a
  generation counter, and probes carry a unique token; recordings are ignored
  unless generation (and token) still match.
- `resetCircuit(key)` is the operator override.

### 6.3 Timeouts and aborts

- Creations default to 30s (`creationTimeoutMs`), overridable per call via
  `timeoutMs` (validated, bounded).
- The factory receives a registry-owned signal that aborts on deadline *or*
  caller abort. `timeoutMs` as received by a factory is the total budget, not
  remaining time — the signal is the authoritative deadline.
- Caller aborts are honored at every stage: before work, during context
  validation, during module load (without cancelling the shared load), and
  during execution.

### 6.4 Per-factory policy overrides

`policies` lets each factory override `creationTimeoutMs`,
`maxConcurrentCreations`, and circuit settings, so a factory wrapping a slow
external dependency and a pure-computation factory can share one registry
without sharing one budget. Policies are validated at construction (unknown
keys and invalid values fail closed with `INVALID_POLICY`) and resolved once
per entry — the hot path does no lookups.

---

## 7. Observability

### 7.1 Events (push)

An optional `onEvent` listener receives operational transitions — the things
`snapshot()` polling structurally cannot see, because both ends of an
incident may resolve between polls. A throwing listener is swallowed:
observability never alters registry behavior. Events cover factory health
only; caller input errors are reported solely to the offending caller.

| Event                 | Payload beyond `key`        | Fired when                                 |
| --------------------- | --------------------------- | ------------------------------------------ |
| `factory-loaded`      | —                           | module import + validation succeeded, adopted |
| `factory-load-failed` | `code`                      | load failed / timed out / failed validation|
| `creation-succeeded`  | `correlationId?`            | validated result returned to caller        |
| `creation-failed`     | `code`, `correlationId?`    | any creation rejection, incl. busy/open    |
| `circuit-opened`      | `consecutiveFailures`       | closed→open, or probe failure re-open      |
| `circuit-probed`      | —                           | open→half-open probe admitted              |
| `circuit-closed`      | —                           | probe succeeded                            |
| `circuit-re-armed`    | —                           | probe ended neutrally; back to open        |
| `factory-invalidated` | —                           | operator called `invalidate()`             |
| `circuit-reset`       | —                           | operator called `resetCircuit()`           |
| `concurrency-reset`   | —                           | operator called `resetConcurrency()`       |

Load events fire only for results the registry *adopted*: a load superseded
mid-flight by `invalidate()` (revision advanced) emits neither
`factory-loaded` nor `factory-load-failed`, so the event stream never
disagrees with `snapshot()`.

### 7.2 Snapshot (pull)

`snapshot()` returns an immutable, deterministic view per factory — sorted by
code units, so ordering is host-locale-independent:
load status, active creations, circuit state with consecutive failures,
aliases, module path, and the stable error code when failed. It exposes no
executable objects — diagnostics cannot become an injection surface.

### 7.3 Operator runbook

| Symptom                              | Likely state              | Remedy                                   |
| ------------------------------------ | ------------------------- | ---------------------------------------- |
| `CIRCUIT_OPEN` persists past window  | repeated real failures    | fix the dependency; `resetCircuit()`     |
| `FACTORY_BUSY` with no live traffic  | leaked slots (hung work)  | `resetConcurrency()`                     |
| `MODULE_LOAD_FAILED` cached          | bad chunk / network       | fix, then `invalidate()`                 |
| Healthy snapshot but users saw errors| transition already closed | subscribe to `onEvent`                   |

`invalidate()`, `resetCircuit()`, and `resetConcurrency()` are deliberately
independent: reloading a module says nothing about its health history, and
vice versa. Pair them for a full operator reset.

---

## 8. Error taxonomy

All failures are `FactoryRegistryError` with a stable machine-readable `code`
(the closed enum `FACTORY_REGISTRY_ERROR_CODES`), a human message, frozen
`details`, and the original `cause` preserved. Codes by category:

- **Registration**: `INVALID_SOURCE`, `DUPLICATE_FACTORY`, `ALIAS_COLLISION`,
  `UNKNOWN_ALIAS_TARGET`, `INVALID_POLICY`
- **Lookup**: `UNKNOWN_FACTORY`
- **Loading**: `MODULE_LOAD_FAILED`, `MODULE_LOAD_TIMEOUT`,
  `INVALID_FACTORY_MODULE`, `FACTORY_KEY_MISMATCH`,
  `FACTORY_PRODUCT_TYPE_MISMATCH`
- **Creation**: `INVALID_EXECUTION_OPTIONS`, `INVALID_FACTORY_CONTEXT`,
  `FACTORY_BUSY`, `CIRCUIT_OPEN`, `FACTORY_CREATION_FAILED`,
  `FACTORY_CREATION_TIMEOUT`, `INVALID_FACTORY_RESULT`, `ABORTED`
- **Fallback**: `INTERNAL_ERROR`

Registration is atomic: a batch of sources (or aliases) is fully validated
before any of it is committed, so a failed `register()` leaves no partial
state.

The Vite harness additionally asserts **catalog coverage** at composition
time: every catalog key must have received a glob-discovered module
(`INVALID_SOURCE` listing the uncovered keys; opt out with `allowEmpty`).
Without this, a factory file that drops out of the glob pattern — moved into
a subdirectory a non-recursive pattern no longer matches — would be the one
misconfiguration to escape composition time and surface only as
`UNKNOWN_FACTORY` at first `create()`. `register()` on the raw registry
stays incremental; the coverage contract belongs to the harness.

---

## 9. Public surface discipline

`src/factory-core/index.ts` re-exports the supported API explicitly — no
`export *`. Internal schemas and helpers (`normalizeFactoryRegistryError`,
the brand schemas) are implementation details that can change freely. A
public-API test pins the exact runtime export list; adding or removing an
export fails the test, converting silent API drift into a deliberate,
reviewed decision. This is the kernel's semver discipline in executable form.

---

## 10. Current foundation checkpoint

The foundation is now implemented and exercised as a generic factory kernel,
not merely described through the aircraft example.

| Area | Current guarantee | Executable proof |
| --- | --- | --- |
| Kernel boundary | `src/factory-core/` imports no consumer domain and owns no domain vocabulary. | Dependency structure and public-API tests |
| Discovery | A `src/<namespace>/factories/*.factory.ts` module is the source of truth for its factory name and product type, and the harness fails composition if any catalog key lacks a discovered module. | Generator fixture tests for additions, removals, ordering, stale output, and invalid declarations; harness catalog-coverage tests |
| Generated vocabulary | `factorySet`, `productTypeSet`, and `factoryDefinitionSet` provide exact design-time access without a hand-maintained central list. | `npm run codegen:check` and catalog type tests |
| Identity | Factory keys select implementations; product types classify results; aliases remain optional lookup synonyms. These concepts do not impersonate one another. | Branded-key validation and module/contract mismatch tests |
| Domain contracts | Each key selects its exact context and result types. The domain chooses the discriminator property and every result branch carries the exact product literal. | Compile-time assertions and strict Zod schemas |
| Runtime trust | Authoring attestation, context, loaded module metadata, raw result, and the parsed result discriminator are all checked before data crosses the registry boundary. | Adversarial registry tests, including a dishonest schema transform and forged-attestation modules |
| Operations | Lazy-load deduplication, timeouts, aborts, bulkheads, circuit breakers, recovery controls, snapshots, and events have defined behavior. | Deterministic registry tests |
| Release gate | Generated output, types, behavior, and bundling are checked together. | `npm run verify` |

Two proof domains demonstrate the abstraction boundary:

- `aircraft` uses `type: 'airliner' | 'freighter'` and different passenger and
  freight input/output shapes.
- `report` uses `format: 'pdf' | 'csv'`, proving that neither the domain nor the
  discriminator name is built into the kernel.

Adding a conforming factory module now makes its key and product relationship
available at design time after generation. No aircraft-specific registry,
alias list, or product-category list must be edited. A domain catalog still
owns the meaningful part that cannot be inferred from a filename: its context
and result schemas, selected discriminator, and resilience policy. A
step-by-step walkthrough for wiring a complete new domain lives in
[adding-a-domain.md](adding-a-domain.md).

This checkpoint intentionally stops before UI, persistence, remote plugin
distribution, or package extraction. Those concerns can now be evaluated
against a stable kernel instead of shaping it prematurely.

### 10.1 How the kernel reached this shape

The kernel was reviewed and hardened across successive foundation passes.
These details are recorded because the *reasons* outlive the diffs.

**Three temporal defects found and fixed** (each individually correct piece
composed into an undefined whole):

1. *Aborted probe wedged the circuit.* Aborts are neutral; neutral outcomes
   recorded nothing; half-open rejects everyone but the probe — so an aborted
   probe stranded the circuit in half-open forever. Fix: neutral probe
   outcomes re-arm the circuit (half-open state now carries `openedAt`).
2. *Leaked bulkhead slots had no recovery.* Slot retention for hung work is
   correct, but nothing could ever reclaim the slots. Fix:
   `resetConcurrency()`, with a floor-at-zero release guard.
3. *Aborts were ignored during module load.* The abort listener attached only
   after load, so callers waited up to 15s to hear "aborted." Fix: race the
   caller's wait (not the shared load) against their signal.

**Three seams added for evolution** (features arrive later; boundaries are
cheap now and expensive to retrofit): the curated export surface, the event
hook, and per-factory policies — each landed with a test that first exposes
the gap it closes, then proves the fix.

**The vocabulary and product-model pass** removed the hand-maintained factory
list, separated aliases from product categories, generated each factory's key
and product relationship, made the result discriminator domain-selectable, and
added a second non-aircraft proof domain.

**Type-level refinements** include the template-literal key constraint,
catalog-parameterized diagnostics (§3.1, §3.4), exact context/result inference,
and compile-time enforcement of each contract's discriminator literal.

**Minor honesty fixes**: half-open `CIRCUIT_OPEN` no longer claims
`retryAfterMs: 0`; module paths reject whitespace padding; `defineFactoryFor`
freezes its output; `timeoutMs` semantics documented.

**The type-soundness audit pass** (the "type-system-breaker" mission)
attacked the kernel's compile-time promises with an adversarial probe suite
and found four places where the types and the runtime disagreed. All four
are fixed; the probe suite proved the bugs, then the fixes, and was archived
out of the tree afterward (the audit report and probes live with the
project's archived records, not in `src/`):

1. *Receiver rebinding severed `this`.* A structurally conforming
   class-instance factory crashed — or worse, silently computed a wrong,
   schema-valid value — through the registry. Fixes: `create(this: void, …)`
   states the receiver contract, and `defineFactoryFor` delegates instead of
   spreading (§3.6). One correction surfaced on the way: `this: void` cannot
   reject *implicit* `this` in class methods, so delegation, not the type
   screen, is what closes that path.
2. *`defineFactoryFor` spread dropped prototype members.* The returned
   object's typed `create` could be `undefined` at runtime. Same delegation
   fix.
3. *`create` signatures were never verified.* `import.meta.glob<T>` is an
   unchecked assertion and the boundary checked only
   `typeof create === 'function'`; an impersonator written against a foreign
   context shape returned schema-valid garbage. Fix: the `DEFINED_FACTORY`
   attestation marker, required at the module boundary (§5).
4. *`FactoryMetadata` was laxer than the boundary schema.* A fully
   type-endorsed module could be rejected wholesale at first load. Fix: the
   semver template-literal screen plus eager metadata parsing at authoring
   time (§3.6).

**The external-audit remediation pass** subjected `factory-core` and
`aircraft` to a staff-level architectural audit and fixed all sixteen
findings. The two Majors were both cracks in the bounded-execution story:

1. *Context validation ran outside the envelope `create()` promises.* Module
   loads and factory runs were deadline-bounded and abortable, but a context
   schema with a hanging async refinement stalled a call forever — the
   caller's signal was polled before and after the parse, never during. Fix:
   the parse is wrapped in the creation timeout and an abort race (§4 step 4);
   a stalled parse never counts against the circuit.
2. *Nothing verified glob discovery covered the catalog.* Every other
   misconfiguration failed at composition time; a factory file that dropped
   out of a non-recursive glob pattern surfaced only as runtime
   `UNKNOWN_FACTORY`. Fix: the harness catalog-coverage assertion (§8).

The remaining findings, in the same pass: `defineFactoryCatalog` adopts
frozen validated contract copies instead of live references (§3.2); Zod
schemas are recognized structurally rather than by cross-copy-fragile
`instanceof` (§3.2); load events are suppressed for revisions superseded by
`invalidate()`, keeping telemetry consistent with `snapshot()` (§7.1); the
circuit/bulkhead/timeout engine moved into the internal `execution.ts`
collaborator with the public API unchanged (§2); all orderings are
code-unit-based rather than host-locale-dependent; the constructor routes
registration through a private helper so a subclass override cannot run
before its own field initializers; `defineFactoryFor` eagerly parses
`productType` alongside metadata (§3.6); the eager-glob mistake is named in
its error message; kernel JSDoc uses a neutral example namespace; and both
proof domains replaced eager module-scope registry singletons with lazy
memoized accessors and re-export only their own slice of the generated
vocabulary.

**The composition-root consolidation pass** followed directly from the
audit's second-domain question: with `report` proving the seams generic, the
two domains' composition roots had converged on forty near-identical lines
each. The repetition was scaffold, not payload — harness wiring,
filename-resolver construction, and the lazy shared-registry accessor — so
it moved into the kernel as `factoryDomainFor(catalog)` (§2), whose builders
need only the consumer's literal glob map (the one piece Vite forces to stay
at the consumer). The filename→key map is no longer hand-exported by each
catalog: it is derived from the catalog's own key names — the convention the
generator already enforces — with an explicit `keyFromPath` override and a
fail-fast `INVALID_SOURCE` when two keys share a stem, since two keys cannot
both map to one filename. Each catalog also curries `defineFactoryFor` once
(`defineAircraftFactory`, `defineReportFactory`) so factory modules stop
re-deriving it. This was a deliberate public-surface addition — the pin test
changed with it, exactly as §9 intends — justified by the extraction goal
rather than the rule of three: every future consumer of the packaged kernel
writes the glob literal, two exports, and its schemas instead of forty lines
of ceremony, and the helper is the natural quick-start API for the package.

---

## 11. Non-goals

Declared refusals, so they don't arrive later as half-considered changes:

- **No queueing behind the bulkhead.** `FACTORY_BUSY` is immediate; queues
  hide backpressure. Callers own retry policy.
- **No registry-wide global concurrency cap.** Cross-factory scheduling
  belongs to the caller's scheduler.
- **No factory unregistration.** Registries are build-time-shaped;
  `invalidate()` is the supported mutation.
- **No sandboxing.** See §5. Worker/process isolation is a different
  architecture, not a feature flag.

## 12. Evolution path (when a driver appears)

- **Tier 1 (contract pinning, no behavior change)**: named tests for
  invalidate-during-flight, preload-vs-circuit independence, reentrant
  creation.
- **Tier 2 (small tightenings)**: `creation-settled-late` event when
  timed-out work finally settles; late-load repair (`failed → ready` when a
  load beats its cached failure); remaining-time `timeoutMs`; `dispose()`.
- **Extraction**: workspace split into `packages/factory-kernel` (Zod-only
  core + Vite/codegen adapters) and proof domains under `examples/`. File moves
  and config only; the tests verify nothing broke.

---

## 13. Testing philosophy

For a kernel, **the test suite is the specification**. The suite asserts
behaviors, temporal contracts (fake timers + deferreds for races, timeouts,
probe lifecycles), adversarial cases (lying modules, mutation attacks,
throwing listeners), type-level guarantees (`expectTypeOf`,
`@ts-expect-error`), and the public API surface itself. Every guarantee this
document claims is intended to have a test whose name states it; a claim
without a test is a bug in either the docs or the suite.

Command: `npm run verify` (fresh codegen, typecheck, tests, and production build)
