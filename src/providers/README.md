# AI Providers & Adapters

Stepper provider adapters are transport-focused integrations for LLM vendors.

## Purpose

- Build provider-specific HTTP request shape (headers/body/endpoint)
- Send prompt to provider
- Extract provider response text
- Map provider failures into typed Stepper provider errors

Business logic (for example CommitDiary prompt semantics) should not live here.

## Runtime contract

All adapters implement `ProviderAdapter` and are routed through:

- `providers/registry.ts`
- `providers/factory.ts`
- `providers/catalog/*.ts`

Provider catalog entries should stay generic and package-branded. Avoid product-specific defaults.

## Supported errors

- `AuthError`
- `RateLimitError`
- `TimeoutError`
- `ProviderUnavailableError`
- `InvalidResponseError`

## Adding a provider

1. Add provider spec in `providers/catalog/`.
2. Register in `providers/registry.ts` switch-case.
3. Add config validation in `validateProviderConfig(...)`.
4. Add/update tests for headers/body/response parsing.

## Compatibility note

CommitDiary compatibility is preserved through `presets/commit-report/*` and legacy route wrappers.
Provider-layer code should remain use-case agnostic.
