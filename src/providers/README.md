# 🔌 AI Providers & Adapters

The **Inference Stepper** supports multiple AI providers through a flexible adapter architecture. This allows the system to switch between providers if one is unavailable or rate-limited.

## 🎯 Purpose

The providers are the "brains" of the system. They:

1.  **Format** code changes (diffs) into prompts the AI understands.
2.  **Communicate** with external AI services (Hugging Face, Gemini, etc.).
3.  **Parse** the AI's response into a standardized JSON report.
4.  **Handle** errors specific to each service.

## 🏗️ Architecture

We use an **Adapter Pattern**. Every provider must implement the `ProviderAdapter` interface:

- `name`: Unique identifier for the provider.
- `call(input: PromptInput)`: The main method that sends data to the AI and returns a result.

### Implementation Types

1.  **HttpTemplateAdapter**: A universal adapter that can be configured for any HTTP-based AI service.
2.  **HuggingFaceSpaceAdapter**: Specialized for Hugging Face Spaces with built-in health checks and specific prompt formatting.

## 🛠️ Security

Before sending any code to an AI provider, the system can **redact secrets**. It scans the diffs for passwords, API keys, and other sensitive information to ensure they never leave your infrastructure.

## 📋 Common Errors Handled

| Error                  | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `AuthError`            | Invalid API key or expired credentials.                              |
| `RateLimitError`       | The provider is busy; we need to wait (respected via `Retry-After`). |
| `TimeoutError`         | The AI took too long to think (default limit is 1 minute).           |
| `InvalidResponseError` | The AI returned something that wasn't a valid report.                |

## 🔄 Adding a New Provider

To add a new provider:

1. Create a new adapter class (or use `HttpTemplateAdapter`).
2. Register it in `config.ts`.
3. The `Orchestrator` will automatically include it in the fallback rotation.
