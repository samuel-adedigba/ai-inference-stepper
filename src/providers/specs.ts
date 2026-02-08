import { ProviderSpec } from "./unified.adapter";


/**
 * All AI provider specifications
 * Add new providers here without creating new files
 * 
 * NOTE: Some providers have unique requirements that differ from standard HTTP APIs.
 * See README.md for provider-specific documentation.
 */
export const PROVIDER_SPECS: Record<string, ProviderSpec> = {
    /**
     * Google Gemini (Gemini 3 Models)
     * 
     * UNIQUE REQUIREMENTS:
     * 1. API Key: Passed in URL query parameter (?key=YOUR_KEY), NOT in headers
     * 2. Temperature: MUST be 1.0 for Gemini 3 (Google requirement for optimal performance)
     * 3. Prompt Structure: Uses XML-style tags (implemented in buildGeminiPrompt())
     * 4. Model Format: Uses versioned names like 'gemini-2.5-flash'
     * 
     * Reference: https://ai.google.dev/gemini-api/docs/prompting-strategies
     */
    gemini: {
        name: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        endpoint: '/v1beta/models/{model}:generateContent',
        apiKeyEnvVar: 'GEMINI_API_KEY',
        defaultModel: 'gemini-2.5-flash', // Gemini 3 model optimized for speed and intelligence

        buildHeaders: (_apiKey) => ({
            'Content-Type': 'application/json',
            // NOTE: API key is NOT in headers for Gemini - it's appended to URL in unified.adapter.ts
        }),

        buildBody: (prompt, _model) => ({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 1.0, // CRITICAL: Must be 1.0 for Gemini 3. Do NOT change. See: https://ai.google.dev/gemini-api/docs/prompting-strategies
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 4096, // Increased from 2048 for more detailed commit analysis
            },
        }),

        parseResponse: (data) => {
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Invalid Gemini response structure');
            return text;
        },
    },

    // OpenAI (GPT-4, GPT-3.5, etc.)
    openai: {
        name: 'openai',
        baseUrl: 'https://api.openai.com',
        endpoint: '/v1/chat/completions',
        apiKeyEnvVar: 'OPENAI_API_KEY',
        defaultModel: 'gpt-4-turbo-preview',

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
        }),

        buildBody: (prompt, model) => ({
            model: model || 'gpt-4-turbo-preview',
            messages: [
                { role: 'system', content: 'You are an expert software engineer analyzing code commits. Always respond with valid JSON only.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2048,
            response_format: { type: 'json_object' },
        }),

        parseResponse: (data) => {
            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error('Invalid OpenAI response structure');
            return text;
        },
    },

    // Anthropic Claude
    anthropic: {
        name: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        endpoint: '/v1/messages',
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        defaultModel: 'claude-3-5-sonnet-20241022',

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'x-api-key': apiKey || '',
            'anthropic-version': '2023-06-01',
        }),

        buildBody: (prompt, model) => ({
            model: model || 'claude-3-5-sonnet-20241022',
            max_tokens: 2048,
            temperature: 0.3,
            messages: [{ role: 'user', content: prompt }],
        }),

        parseResponse: (data) => {
            const text = data?.content?.[0]?.text;
            if (!text) throw new Error('Invalid Anthropic response structure');
            return text;
        },
    },

    // Cohere
    cohere: {
        name: 'cohere',
        baseUrl: 'https://api.cohere.ai',
        endpoint: '/v1/chat',
        apiKeyEnvVar: 'COHERE_API_KEY',
        defaultModel: 'command-r-plus',

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
        }),

        buildBody: (prompt, model) => ({
            model: model || 'command-r-plus',
            message: prompt,
            temperature: 0.3,
            max_tokens: 2048,
            preamble: 'You are an expert software engineer. Respond with valid JSON only.',
        }),

        parseResponse: (data) => {
            const text = data?.text;
            if (!text) throw new Error('Invalid Cohere response structure');
            return text;
        },
    },

    // DeepSeek
    deepseek: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        endpoint: '/v1/chat/completions',
        apiKeyEnvVar: 'DEEPSEEK_API_KEY',
        defaultModel: 'deepseek-chat',

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
        }),

        buildBody: (prompt, model) => ({
            model: model || 'deepseek-chat',
            messages: [
                { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2048,
        }),

        parseResponse: (data) => {
            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error('Invalid DeepSeek response structure');
            return text;
        },
    },

    // Groq (Fast inference)
    groq: {
        name: 'groq',
        baseUrl: 'https://api.groq.com/openai',
        endpoint: '/v1/chat/completions',
        apiKeyEnvVar: 'GROQ_API_KEY',
        defaultModel: 'mixtral-8x7b-32768',
        useSimplePrompt: true, // Use simpler prompt for speed

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
        }),

        buildBody: (prompt, model) => ({
            model: model || 'mixtral-8x7b-32768',
            messages: [
                { role: 'system', content: 'Return valid JSON only.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2048,
        }),

        parseResponse: (data) => {
            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error('Invalid Groq response structure');
            return text;
        },
    },

    // OpenRouter (Access to multiple models)
    openrouter: {
        name: 'openrouter',
        baseUrl: 'https://openrouter.ai/api',
        endpoint: '/v1/chat/completions',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        defaultModel: 'anthropic/claude-3.5-sonnet',

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
            'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://commitdiary.com',
            'X-Title': process.env.OPENROUTER_TITLE || 'CommitDiary Stepper',
        }),

        buildBody: (prompt, model) => ({
            model: model || 'anthropic/claude-3.5-sonnet',
            messages: [
                { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2048,
        }),

        parseResponse: (data) => {
            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error('Invalid OpenRouter response structure');
            return text;
        },
    },

    // Mistral AI
    mistral: {
        name: 'mistral',
        baseUrl: 'https://api.mistral.ai',
        endpoint: '/v1/chat/completions',
        apiKeyEnvVar: 'MISTRAL_API_KEY',
        defaultModel: 'mistral-large-latest',

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
        }),

        buildBody: (prompt, model) => ({
            model: model || 'mistral-large-latest',
            messages: [
                { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2048,
        }),

        parseResponse: (data) => {
            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error('Invalid Mistral response structure');
            return text;
        },
    },

    // Perplexity AI
    perplexity: {
        name: 'perplexity',
        baseUrl: 'https://api.perplexity.ai',
        endpoint: '/chat/completions',
        apiKeyEnvVar: 'PERPLEXITY_API_KEY',
        defaultModel: 'llama-3.1-sonar-large-128k-online',

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
        }),

        buildBody: (prompt, model) => ({
            model: model || 'llama-3.1-sonar-large-128k-online',
            messages: [
                { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2048,
        }),

        parseResponse: (data) => {
            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error('Invalid Perplexity response structure');
            return text;
        },
    },

    // Together AI
    together: {
        name: 'together',
        baseUrl: 'https://api.together.xyz',
        endpoint: '/v1/chat/completions',
        apiKeyEnvVar: 'TOGETHER_API_KEY',
        defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',

        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
        }),

        buildBody: (prompt, model) => ({
            model: model || 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
            messages: [
                { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2048,
        }),

        parseResponse: (data) => {
            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error('Invalid Together AI response structure');
            return text;
        },
    },
};

/**
 * Get provider spec by name
 */
export function getProviderSpec(name: string): ProviderSpec | undefined {
    return PROVIDER_SPECS[name.toLowerCase()];
}

/**
 * Get all available provider names
 */
export function getAvailableProviders(): string[] {
    return Object.keys(PROVIDER_SPECS);
}