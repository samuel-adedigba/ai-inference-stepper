# Orchestrator Runtime Flow

The orchestrator is the reliability core of Stepper.

## Responsibilities

- initialize usable providers
- enforce per-provider concurrency/rate guards
- execute provider chain with retry/fallback policy
- emit callback events
- return structured attempt metadata

## Execution sequence

1. Validate provider availability (`initializeProviders` path).
2. For each provider:
   - skip if circuit is open
   - attempt call under limiter + circuit breaker
   - apply retry policy for retryable errors
   - on success, return immediately
3. If all providers fail:
   - if all are rate-limited: throw retryable aggregate error
   - otherwise use compatibility fallback (commit preset path)

## Why circuit + limiter together

- limiter protects external quotas and prevents burst overload
- circuit breaker avoids repeatedly calling known-failing providers
- combined, they reduce cost and cascading failure risk

## Callback model

Supported lifecycle callbacks include:
- start
- provider attempt
- success
- fallback
- failure

Callbacks are invoked safely to prevent callback-level exceptions from crashing orchestration.

## Compatibility note

Orchestrator runtime is request-first (`StepperRequest`) and keeps commit-report behavior through preset wrappers.
