# 🎼 Inference Orchestrator

The Orchestrator is the "Head Chef" of the package. It coordinates the various AI providers, handles retries, and ensures that the user always receives a report, even if multiple providers fail.

## 🎯 Purpose

- **Reliability**: Implements a rotation of providers. If one fails, it tries the next.
- **Resilience**: Uses **Circuit Breakers** and **Exponential Backoff**.
- **Efficiency**: Respects rate limits via **Bottleneck** (e.g., max 5 requests per minute).

## 🛡️ Resilience Strategies

### 1. Circuit Breaker

If a provider fails more than 50% of the time, the "circuit flips open." The Orchestrator will stop sending requests to that provider for 5 minutes to give it time to recover.

### 2. Smart Retries

When a provider fails with a temporary error (like a network blip), the Orchestrator waits before trying again:

- **Base Delay**: 40 seconds.
- **Exponential Backoff**: Each retry waits longer than the last.
- **Jitter**: Adds randomness to avoid "thundering herd" problems.

### 3. Rate Limiting

Controls the flow of requests.

- **Requests Per Minute (RPM)**: Default is 5.
- **Concurrency**: Default is 2 simultaneous requests.

### 4. Fail-safe Fallback

If _all_ AI providers are down or timeout (after 1 minute), the Orchestrator generates a generic, high-quality template report based on the commit message. This ensures the user is never left with an empty result.

## 📋 Core Functions

| Function                | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `generateReportNow()`   | The high-level entry point that manages the entire multi-provider flow. |
| `initializeProviders()` | Sets up the rate limiters and circuit breakers for each service.        |
| `callWithRetries()`     | Handles the low-level retry logic for a single provider.                |
| `getProviderHealth()`   | Returns the current status (Healthy/Broken) of all AI services.         |
