import type { FactoryAlias, FactoryKey } from './brand'
import type { Awaitable, FactoryCreateOptions } from './contracts'
import { FactoryRegistryError } from './errors'

/**
 * Internal per-entry execution engine: circuit breaker, concurrency
 * bulkhead, and bounded-execution helpers, apart from the registry's
 * registration and module-lifecycle concerns. Not part of the public
 * surface — the registry is its only consumer, but nothing here depends on
 * the registry, so the resilience machinery can be reused or tree-shaken
 * independently.
 */

export type FactoryCircuitStatus = 'closed' | 'half-open' | 'open'

export interface FactoryCircuitSnapshot {
  readonly consecutiveFailures: number
  readonly status: FactoryCircuitStatus
}

export interface FactoryEntryPolicy {
  readonly circuitFailureThreshold: number
  readonly circuitResetTimeoutMs: number
  readonly creationTimeoutMs: number
  readonly maxConcurrentCreations: number
}

/**
 * The subset of registry events this engine produces. Every variant is
 * structurally identical to its FactoryRegistryEvent counterpart, so the
 * registry's emitter is directly assignable as the engine's sink.
 */
export type FactoryExecutionEvent =
  | { readonly key: FactoryKey; readonly type: 'circuit-closed' }
  | {
      readonly consecutiveFailures: number
      readonly key: FactoryKey
      readonly type: 'circuit-opened'
    }
  | { readonly key: FactoryKey; readonly type: 'circuit-probed' }
  | { readonly key: FactoryKey; readonly type: 'circuit-re-armed' }
  | {
      readonly code: 'CIRCUIT_OPEN' | 'FACTORY_BUSY'
      readonly correlationId?: string
      readonly key: FactoryKey
      readonly type: 'creation-failed'
    }

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

export type CircuitPermit =
  | { readonly generation: number; readonly kind: 'closed' }
  | {
      readonly generation: number
      readonly kind: 'half-open'
      readonly probeToken: symbol
    }

function closedCircuit(generation = 0): CircuitState {
  return {
    consecutiveFailures: 0,
    generation,
    status: 'closed',
  }
}

export class FactoryEntryExecution {
  #activeCreations = 0
  #circuit: CircuitState = closedCircuit()
  readonly #emit: (event: FactoryExecutionEvent) => void
  readonly #key: FactoryKey
  readonly policy: FactoryEntryPolicy

  constructor(options: {
    readonly emit: (event: FactoryExecutionEvent) => void
    readonly key: FactoryKey
    readonly policy: FactoryEntryPolicy
  }) {
    this.#emit = options.emit
    this.#key = options.key
    this.policy = options.policy
  }

  get activeCreations(): number {
    return this.#activeCreations
  }

  get circuit(): FactoryCircuitSnapshot {
    return Object.freeze({
      consecutiveFailures: this.#circuit.consecutiveFailures,
      status: this.#circuit.status,
    })
  }

  acquireSlot(correlationId?: string): () => void {
    if (this.#activeCreations >= this.policy.maxConcurrentCreations) {
      this.#emit({
        ...(correlationId === undefined ? {} : { correlationId }),
        code: 'FACTORY_BUSY',
        key: this.#key,
        type: 'creation-failed',
      })
      throw new FactoryRegistryError(
        'FACTORY_BUSY',
        `Factory "${this.#key}" reached its concurrency limit.`,
        {
          details: {
            activeCreations: this.#activeCreations,
            key: this.#key,
            maxConcurrentCreations: this.policy.maxConcurrentCreations,
          },
        },
      )
    }

    this.#activeCreations += 1
    let released = false
    return () => {
      if (!released) {
        released = true
        // resetConcurrency() may have already reclaimed this slot.
        this.#activeCreations = Math.max(0, this.#activeCreations - 1)
      }
    }
  }

  acquireCircuitPermit(correlationId?: string): CircuitPermit {
    const circuit = this.#circuit
    const rejectCreation = (retryAfterMs?: number): FactoryRegistryError => {
      this.#emit({
        ...(correlationId === undefined ? {} : { correlationId }),
        code: 'CIRCUIT_OPEN',
        key: this.#key,
        type: 'creation-failed',
      })
      return this.#circuitOpenError(retryAfterMs)
    }

    if (circuit.status === 'closed') {
      return { generation: circuit.generation, kind: 'closed' }
    }

    // A probe is already in flight; no retry delay can be promised.
    if (circuit.status === 'half-open') {
      throw rejectCreation()
    }

    const elapsedMs = Date.now() - circuit.openedAt
    if (elapsedMs < this.policy.circuitResetTimeoutMs) {
      throw rejectCreation(this.policy.circuitResetTimeoutMs - elapsedMs)
    }

    const probeToken = Symbol('factory-circuit-probe')
    const generation = circuit.generation + 1
    this.#circuit = {
      consecutiveFailures: circuit.consecutiveFailures,
      generation,
      openedAt: circuit.openedAt,
      probeToken,
      status: 'half-open',
    }
    this.#emit({ key: this.#key, type: 'circuit-probed' })
    return { generation, kind: 'half-open', probeToken }
  }

  /**
   * Returns a half-open circuit to the open state when its probe ends with a
   * neutral outcome (for example a caller abort) that says nothing about
   * factory health. The original openedAt is preserved, so the reset window
   * has already elapsed and the next creation is admitted as a fresh probe.
   */
  releaseCircuitProbe(permit: CircuitPermit): void {
    const circuit = this.#circuit

    if (
      permit.kind === 'half-open' &&
      circuit.status === 'half-open' &&
      circuit.generation === permit.generation &&
      circuit.probeToken === permit.probeToken
    ) {
      this.#circuit = {
        consecutiveFailures: circuit.consecutiveFailures,
        generation: circuit.generation + 1,
        openedAt: circuit.openedAt,
        status: 'open',
      }
      this.#emit({ key: this.#key, type: 'circuit-re-armed' })
    }
  }

  recordCircuitSuccess(permit: CircuitPermit): void {
    const circuit = this.#circuit

    if (
      permit.kind === 'half-open' &&
      circuit.status === 'half-open' &&
      circuit.generation === permit.generation &&
      circuit.probeToken === permit.probeToken
    ) {
      this.#circuit = closedCircuit(circuit.generation + 1)
      this.#emit({ key: this.#key, type: 'circuit-closed' })
      return
    }

    if (
      permit.kind === 'closed' &&
      circuit.status === 'closed' &&
      circuit.generation === permit.generation &&
      circuit.consecutiveFailures !== 0
    ) {
      this.#circuit = closedCircuit(circuit.generation)
    }
  }

  recordCircuitFailure(permit: CircuitPermit): void {
    const circuit = this.#circuit

    if (
      permit.kind === 'half-open' &&
      circuit.status === 'half-open' &&
      circuit.generation === permit.generation &&
      circuit.probeToken === permit.probeToken
    ) {
      const consecutiveFailures = circuit.consecutiveFailures + 1
      this.#circuit = {
        consecutiveFailures,
        generation: circuit.generation + 1,
        openedAt: Date.now(),
        status: 'open',
      }
      this.#emit({
        consecutiveFailures,
        key: this.#key,
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
    if (consecutiveFailures >= this.policy.circuitFailureThreshold) {
      this.#circuit = {
        consecutiveFailures,
        generation: circuit.generation + 1,
        openedAt: Date.now(),
        status: 'open',
      }
      this.#emit({
        consecutiveFailures,
        key: this.#key,
        type: 'circuit-opened',
      })
    } else {
      this.#circuit = {
        consecutiveFailures,
        generation: circuit.generation,
        status: 'closed',
      }
    }
  }

  resetCircuit(): void {
    this.#circuit = closedCircuit(this.#circuit.generation + 1)
  }

  resetConcurrency(): void {
    this.#activeCreations = 0
  }

  #circuitOpenError(retryAfterMs?: number): FactoryRegistryError {
    return new FactoryRegistryError(
      'CIRCUIT_OPEN',
      `Factory "${this.#key}" is temporarily unavailable because its circuit is open.`,
      {
        details: {
          key: this.#key,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      },
    )
  }
}

function abortedError(
  key: FactoryKey | FactoryAlias,
  signal: AbortSignal,
): FactoryRegistryError {
  return new FactoryRegistryError(
    'ABORTED',
    `Factory creation for "${key}" was aborted.`,
    { cause: signal.reason, details: { key } },
  )
}

export function assertNotAborted(
  key: FactoryKey | FactoryAlias,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) {
    throw abortedError(key, signal)
  }
}

/**
 * Rejects this caller as soon as their signal aborts, without cancelling
 * the shared operation (other callers may be awaiting the same load). The
 * abandoned operation's eventual rejection is silenced to avoid an
 * unhandled-rejection report when no caller remains.
 */
export function awaitWithAbort<Value>(
  operation: Promise<Value>,
  key: FactoryKey | FactoryAlias,
  signal: AbortSignal | undefined,
): Promise<Value> {
  if (signal === undefined) {
    return operation
  }

  if (signal.aborted) {
    operation.catch(() => {})
    return Promise.reject(abortedError(key, signal))
  }

  return new Promise<Value>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {})
      reject(abortedError(key, signal))
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

export function withTimeout<Value>(
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

export function runWithExecutionControls<Value>(
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
      rejectOnce(abortedError(key, signal))
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
