# Validation & Output Parsing

Stepper validation is mode-driven and preset-aware.

## Goals

- parse provider output safely
- provide actionable errors on malformed output
- support generic callers with optional schema validation
- preserve preset validation behavior for migration safety

## Parser modules

- `parseTextOutput(raw, schema?)`
  - for text-mode responses
  - applies optional schema validation/transformation on raw text
- `parseJsonOutput(raw, schema?)`
  - parses JSON
  - applies optional schema validation
- `parseZodOutput(value, zodSchema)`
  - direct zod validation helper
- `providerOutput` router
  - chooses parser path by request mode/preset

## Routing behavior

1. `preset: commit-report` -> commit-report schema validation
2. generic `responseMode: text` -> text parser (+ optional schema)
3. generic `responseMode: json` (or default) -> json parser (+ optional schema)

## Compatibility note

`validation/report.schema.ts` remains as compatibility shim for legacy imports.

## Note

- text-mode schema validation is now supported for generic requests.
- if advanced schema behavior is needed (for example rich object validation), prefer `responseMode: "json"` and a JSON schema parser path.
