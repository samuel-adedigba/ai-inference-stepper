# Stepper documentation

Stepper is a generic inference orchestration layer for Node.js and TypeScript. These documents explain how to adopt it,
run it, integrate with its HTTP API, and contribute safely.

## Start here

Choose the path that matches your work:

| You want to… | Read this | What you will get |
| --- | --- | --- |
| Use Stepper in an application | [Developer implementation guide](./DEVELOPER_IMPLEMENTATION_GUIDE.md) | Setup, request shapes, job lifecycle, routing, caching, callbacks, and deployment |
| Run Stepper as an HTTP service | [Developer implementation guide](./DEVELOPER_IMPLEMENTATION_GUIDE.md#http-contract) | HTTP request and response contract, authentication, polling, and failure handling |
| Process many independent items | [Batch generation](./DEVELOPER_IMPLEMENTATION_GUIDE.md#batch-generation) | Stable IDs, bounded concurrency, progress, alignment, and per-item failures |
| Understand the internals | [Architecture reference](../ARCHITECTURE.md) | Queue, worker, cache, provider, and callback flow |
| Verify a change locally | [Testing guide](../TESTING_GUIDE.md) | Typecheck, unit tests, integration tests, and local dependencies |
| Add or change a provider | [Provider guide](../src/providers/README.md) | Adapter boundaries, provider registration, errors, and tests |
| Understand output validation | [Validation guide](../src/validation/README.md) | Text/JSON parsing, presets, and schema behavior |
| Understand cache behavior | [Cache guide](../src/cache/README.md) | Keys, fresh/stale results, queued state, and failure state |
| Understand queue behavior | [Queue guide](../src/queue/README.md) | BullMQ producer, worker, retries, and persistence |
| Contribute to the roadmap | [API feedback](./STEPPER_API_FEEDBACK.md) | Integration evidence, priorities, current status, and help wanted |

## Recommended reading order

1. Read the [developer implementation guide](./DEVELOPER_IMPLEMENTATION_GUIDE.md).
2. Choose either the library or HTTP integration mode.
3. Read the [architecture reference](../ARCHITECTURE.md) before changing queue, cache, or provider behavior.
4. Run the [testing guide](../TESTING_GUIDE.md) before opening a pull request.
5. Check the [API feedback](./STEPPER_API_FEEDBACK.md) for known gaps and planned work.

## Documentation conventions

- The generic request API is the primary public contract.
- Commit reports are a compatibility preset, not the definition of Stepper.
- Provider credentials belong in trusted server configuration, never in HTTP request bodies.
- Consumers should use stable machine-readable fields such as `status` and `failure.errorCode`.
- Documentation examples use environment variables for secrets and avoid private prompt data.

## Package and repository copies

The `docs/` directory, architecture reference, testing guide, and linked component guides are included in the published
npm package. Links in this documentation use relative paths so they work both on GitHub and after installing
`ai-inference-stepper`.

If a guide references an internal source module, use the repository copy for implementation details. The installed npm
package contains the compiled API and the curated public guides, not the full source tree.

## Need help?

When opening an issue, say which integration mode you use, include the endpoint or library function, and provide the
public status and error code. Remove API keys, authorization headers, private prompts, and provider responses before
sharing logs.
