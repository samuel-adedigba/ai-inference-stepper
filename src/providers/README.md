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

## 🌟 Provider-Specific Implementations

### Google Gemini (Gemini 3 Models)

**Why Gemini is Different:**

Gemini 3 models (like `gemini-2.5-flash`) have unique requirements that differ from other AI providers. Our implementation follows [Google's official prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies) to maximize performance and reliability.

#### Key Differences:

1. **XML-Structured Prompts**
   - Gemini 3 responds best to prompts with clear XML-style tags
   - Tags like `<role>`, `<instructions>`, `<constraints>`, `<context>`, `<task>`, and `<output_format>` help the model understand the request structure
   - This is different from other providers that use markdown or plain text formatting
   - Implemented in `buildGeminiPrompt()` function in `promptBuilder.ts`

2. **API Key Authentication**
   - Gemini requires the API key as a **query parameter** (`?key=YOUR_KEY`), not in headers
   - Most other providers use `Authorization: Bearer` headers
   - Conditional logic in `unified.adapter.ts` appends the key to the URL for Gemini only

3. **Temperature Configuration**
   - **CRITICAL**: Gemini 3 models MUST use `temperature: 1.0`
   - Google's documentation explicitly warns: "Changing the temperature (setting it below 1.0) may lead to unexpected behavior, such as looping or degraded performance"
   - Other providers typically use lower temperatures (0.2-0.7) for deterministic outputs
   - Our specs.ts locks Gemini's temperature at 1.0

4. **Increased Token Limit**
   - Gemini 3 supports up to 4096 output tokens
   - We use this higher limit for more detailed commit analysis reports
   - Other providers typically limit to 2048 tokens

5. **Model Naming**
   - Gemini uses versioned model names: `gemini-2.5-flash`, `gemini-3-flash-preview`
   - Different from OpenAI's `gpt-4` or Anthropic's `claude-3` naming schemes

#### Implementation Pattern:

```typescript
// Conditional rendering based on provider name
if (this.spec.name === 'gemini') {
    // Use Gemini-specific XML prompt
    prompt = buildGeminiPrompt(input);
    // Append API key to URL
    actualEndpoint = `${actualEndpoint}?key=${this.apiKey}`;
} else {
    // Use standard prompt for other providers
    prompt = buildComprehensivePrompt(input);
}
```

#### Configuration:

```env
GEMINI_ENABLED=true
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
GEMINI_BASE_URL=https://generativelanguage.googleapis.com
GEMINI_TIMEOUT=60000  # 60 seconds for complex analysis
```

#### References:
- [Google Gemini API Prompting Strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)
- [Gemini 3 Model Documentation](https://ai.google.dev/gemini-api/docs/models/gemini-v3)
- [Text Generation Guide](https://ai.google.dev/gemini-api/docs/text-generation)

#### When to Add Provider-Specific Logic:

Consider adding provider-specific implementations when:
1. The provider's API authentication differs from standard Bearer tokens
2. The model performs significantly better with specific prompt structures
3. The provider has unique configuration requirements (like temperature constraints)
4. Response formats need special parsing logic

This pattern ensures each provider can be optimized for maximum performance while maintaining a clean, maintainable codebase.
