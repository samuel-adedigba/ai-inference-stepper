# Provider Interaction Model

This document describes how Stepper routes inference across providers.

## High-level flow

1. Orchestrator receives a generation request.
2. Provider registry resolves enabled adapters.
3. Orchestrator attempts providers in configured order.
4. Each adapter:
   - renders prompt via shared runtime prompt router
   - builds provider-specific HTTP request
   - parses provider-specific response text
   - hands parsed text to output parser router
5. On success, orchestrator returns provider result and metadata.
6. On failure, orchestrator records attempt and may fall back to next provider.

## Error categories

- auth/config errors
- rate-limit errors
- provider unavailability/timeouts
- invalid response format

These are mapped into typed provider errors so fallback logic remains consistent across vendors.

## Rate-limit behavior

- default strategy: `fallback`
  - fail current provider and continue chain
- compatibility strategy: `wait`
  - wait retry-after duration inline per provider retry policy

## Why this design

- isolates vendor-specific logic to adapter/catalog layers
- keeps orchestration and retry policy vendor-agnostic
- allows adding providers with minimal impact on other paths

## Compatibility note

CommitDiary-specific prompt/report semantics are preset-owned (`presets/commit-report/*`) and should not be reintroduced into provider core.
