import { PromptInput } from '../types.js';
import { redactSecrets } from '../utils/redaction.js';
import { config } from '../config.js';

/**
 * Build a comprehensive, detailed prompt for AI models to generate commit reports
 * This ensures consistent, structured output across all providers
 */
export function buildComprehensivePrompt(input: PromptInput): string {
    let prompt = `You are a senior software engineer analyzing a code commit. Your task is to generate a structured, professional commit report in valid JSON format.

## COMMIT INFORMATION
Repository: ${input.repo}
Commit SHA: ${input.commitSha}
Commit Message: ${input.message}

Files Changed (${input.files.length} files):
${input.files.slice(0, 30).map((f, i) => `${i + 1}. ${f}`).join('\n')}
${input.files.length > 30 ? `... and ${input.files.length - 30} more files` : ''}

Affected Components: ${input.components.join(', ') || 'General'}

## DIFF SUMMARY
${input.diffSummary.slice(0, 3000)}
${input.diffSummary.length > 3000 ? '\n[Diff truncated for brevity...]' : ''}

## ANALYSIS INSTRUCTIONS

You MUST analyze the above commit information and produce a JSON object with EXACTLY these fields:

1. **title** (string, max 120 characters):
   - Create a clear, concise title summarizing the main purpose of this commit
   - Format: "[Component] Action taken" (e.g., "Auth: Add token refresh logic")
   - Be specific about WHAT was changed, not just "Updated files"
   - Use active voice and present tense

2. **summary** (string, max 2000 characters):
   - Write 2-3 paragraphs explaining the commit's purpose and context
   - First paragraph: What problem does this solve or what feature does it add?
   - Second paragraph: How was it implemented? What approach was taken?
   - Third paragraph (if needed): Any important technical decisions or trade-offs
   - Base your summary ONLY on the actual code changes shown in the diff
   - Do NOT make assumptions about code you cannot see

3. **changes** (array of strings, REQUIRED, minimum 1 item, max 50 items):
   - CRITICAL: This array MUST contain at least one change item
   - List specific, concrete changes made in this commit
   - Each item should be one clear, atomic change
   - Format: "Added X to Y", "Modified Z in W", "Removed A from B"
   - Focus on WHAT changed, not why (the why goes in rationale)
   - Examples:
     * "Added validateToken() function to auth.ts"
     * "Modified user login flow to include token refresh"
     * "Removed deprecated session handling code"
   - Be specific with file names and function names when relevant
   - If you see file changes but cannot determine specifics, use: "Modified [filename]"

4. **rationale** (string, max 2000 characters):
   - Explain WHY these changes were made
   - What problem or requirement drove this commit?
   - Why was this particular approach chosen?
   - Reference the commit message and code patterns you observe
   - If the commit message provides context, incorporate it
   - Do NOT speculate beyond what's evident in the code

5. **impact_and_tests** (string, max 2000 characters):
   - Analyze the impact of these changes:
     * Which parts of the system are affected?
     * Are there potential breaking changes?
     * What edge cases should be considered?
   - Identify testing needs:
     * What should be tested (unit tests, integration tests)?
     * Which scenarios need coverage?
     * Are there any test files in the changed files?
   - If test files are present, mention what they're testing
   - Be practical and specific about test requirements

6. **next_steps** (array of strings, max 20 items):
   - List actionable follow-up tasks or recommendations
   - Each item should be a clear, specific action
   - Examples:
     * "Update API documentation for new authentication flow"
     * "Add integration tests for token refresh scenario"
     * "Review error handling in edge cases"
     * "Monitor performance impact in production"
   - Prioritize by importance/urgency
   - Only suggest steps that are actually needed based on the changes

7. **tags** (string, max 200 characters):
   - Comma-separated list of relevant tags
   - Use component names from the input when applicable
   - Add functional categories: "feature", "bugfix", "refactor", "security", "performance", "documentation"
   - Examples: "auth, security, bugfix" or "api, performance, refactor"
   - Keep it concise and relevant

## CRITICAL REQUIREMENTS

1. **Output ONLY valid JSON** - No markdown, no code blocks, no backticks, no explanatory text
2. **Use ONLY the exact field names** specified above
3. **Base analysis on actual code changes** - Do not hallucinate features or changes not shown
4. **Be specific and concrete** - Avoid vague statements like "various improvements"
5. **Stay within character limits** for each field
6. **Use proper grammar and professional tone**
7. **If information is unclear**, state what you can determine and acknowledge uncertainty
8. **Focus on facts from the diff**, not assumptions

## OUTPUT FORMAT

Return your response as a single JSON object like this:

{
  "title": "Clear, specific title under 120 chars",
  "summary": "2-3 paragraph explanation of the commit...",
  "changes": [
    "Specific change 1",
    "Specific change 2"
  ],
  "rationale": "Explanation of why these changes were made...",
  "impact_and_tests": "Analysis of impact and testing requirements...",
  "next_steps": [
    "Actionable follow-up task 1",
    "Actionable follow-up task 2"
  ],
  "tags": "component1, component2, category"
}

## EXAMPLES OF GOOD vs BAD RESPONSES

GOOD title: "Auth: Implement JWT token refresh mechanism"
BAD title: "Updated authentication" (too vague)

GOOD change: "Added refreshToken() method to AuthService class"
BAD change: "Made improvements to authentication" (not specific)

GOOD rationale: "Token refresh was needed to prevent users from being logged out during active sessions. The previous implementation lacked automatic renewal, causing poor UX when tokens expired."
BAD rationale: "To make authentication better" (lacks detail and reasoning)

Now analyze the commit and return ONLY the JSON object with no additional text.`;

    // Redact sensitive information if configured
    if (config.security.redactBeforeSend) {
        prompt = redactSecrets(prompt);
    }

    return prompt;
}

/**
 * Build a lightweight prompt for faster/simpler models
 */
export function buildSimplePrompt(input: PromptInput): string {
    let prompt = `Analyze this code commit and return a JSON report.

Repository: ${input.repo}
Commit: ${input.commitSha}
Message: ${input.message}
Files: ${input.files.slice(0, 10).join(', ')}
Components: ${input.components.join(', ')}

Diff:
${input.diffSummary.slice(0, 1500)}

Return valid JSON with these exact fields:
- title: Brief description (under 120 chars)
- summary: What changed and why (2-3 sentences)
- changes: Array of specific changes made (REQUIRED: minimum 1 item)
- rationale: Why these changes were needed
- impact_and_tests: Impact analysis and testing needs
- next_steps: Array of follow-up tasks
- tags: Comma-separated relevant tags

CRITICAL: The "changes" array MUST have at least 1 item.
Output ONLY valid JSON, no markdown or extra text.`;

    if (config.security.redactBeforeSend) {
        prompt = redactSecrets(prompt);
    }

    return prompt;
}

/**
 * Build prompt with custom instructions
 */
export function buildCustomPrompt(
    input: PromptInput,
    customInstructions?: string
): string {
    const basePrompt = buildComprehensivePrompt(input);

    if (customInstructions) {
        return `${basePrompt}\n\n## ADDITIONAL INSTRUCTIONS\n${customInstructions}`;
    }

    return basePrompt;
}

/**
 * Build Gemini-specific prompt with XML structure (optimized for Gemini 3 models)
 * 
 * Google Gemini 3 performs significantly better with XML-structured prompts compared to
 * traditional markdown or unstructured text. This function implements Google's recommended
 * prompt engineering strategies for Gemini.
 * 
 * Key Differences from Other Providers:
 * - Uses XML tags (<role>, <instructions>, <constraints>, <context>, <task>, <output_format>)
 * - Follows Google's prompting hierarchy: role definition → instructions → constraints → context → task
 * - Optimized for Gemini's multi-turn conversational model architecture
 * - Structured for better token efficiency with Gemini's 4096 output limit
 * 
 * Reference: https://ai.google.dev/gemini-api/docs/prompting-strategies
 * 
 * @param input - The commit data to analyze (repo, commitSha, message, files, diffSummary, components)
 * @returns XML-structured prompt string optimized for Gemini 3 models
 */
export function buildGeminiPrompt(input: PromptInput): string {
    let prompt = `<role>
You are a senior software engineer with expertise in code analysis, architectural patterns, and software development best practices. You analyze commits with precision and provide actionable insights.
</role>

<instructions>
1. **Plan**: Examine the commit structure, files changed, and diff content
2. **Execute**: Generate a comprehensive analysis following the exact output format
3. **Validate**: Ensure all required fields are present and within character limits
4. **Format**: Return ONLY valid JSON - no markdown, no code blocks, no extra text
</instructions>

<constraints>
- Base your analysis ENTIRELY on the provided diff and commit data
- Do NOT make assumptions about code you cannot see
- Stay within specified character limits for each field
- Use professional, technical language appropriate for engineering teams
- Focus on facts derived from the actual code changes
- Avoid speculation about functionality not visible in the diff
</constraints>

<context>
Repository: ${input.repo}
Commit SHA: ${input.commitSha}
Commit Message: ${input.message}

Files Changed (${input.files.length} total):
${input.files.slice(0, 30).map((f, i) => `${i + 1}. ${f}`).join("\\n")}
${input.files.length > 30 ? `... and ${input.files.length - 30} more files` : ""}

Affected Components: ${input.components.join(", ") || "General"}

## CODE DIFF
${input.diffSummary.slice(0, 3000)}
${input.diffSummary.length > 3000 ? "\\n[Diff content truncated for context length...]" : ""}
</context>

<task>
Analyze the commit above and generate a structured JSON report with these EXACT fields:

1. **title** (string, max 120 characters):
   - Clear, specific summary: "[Component] Action taken"
   - Example: "Auth: Add JWT token refresh mechanism"
   - Use active voice, present tense

2. **summary** (string, max 2000 characters):
   - Paragraph 1: Problem solved or feature added
   - Paragraph 2: Implementation approach and key technical decisions
   - Paragraph 3 (optional): Trade-offs or architectural considerations
   - Stay grounded in visible code changes

3. **changes** (array of strings, REQUIRED, minimum 1 item, max 50 items):
   - CRITICAL: This array MUST contain at least one change item
   - List specific, atomic changes: "Added X to Y", "Modified Z in W"
   - Focus on WHAT changed, not WHY
   - Each change should be a complete sentence describing one modification
   - Examples:
     * "Added handleTokenRefresh() method to AuthService"
     * "Modified login endpoint to return refresh token"
     * "Removed deprecated session storage logic"
   - If you see file changes but cannot determine specifics, use: "Modified [filename]"

4. **rationale** (string, max 2000 characters):
   - Explain WHY these changes were necessary
   - Technical reasoning behind the approach
   - Benefits of this implementation

5. **impact_and_tests** (string, max 2000 characters):
   - What systems/components are affected?
   - What should be tested?
   - Potential risks or side effects
   - Performance implications if visible

6. **next_steps** (array of strings, max 20 items):
   - Actionable follow-up tasks
   - Suggested improvements or refactorings
   - Documentation needs
   - Examples:
     * "Add integration tests for token refresh flow"
     * "Update API documentation with new endpoints"

7. **tags** (string, max 200 characters):
   - Comma-separated relevant tags
   - Include: component names, change types, technologies
   - Example: "auth, security, jwt, backend, api"
</task>

<output_format>
Return ONLY a valid JSON object. No markdown code blocks. No backticks. No explanatory text before or after.

CRITICAL: The "changes" array MUST have at least 1 item. Do not return an empty array.

{
  "title": "Component: Clear action description under 120 chars",
  "summary": "Detailed explanation in 2-3 paragraphs...",
  "changes": ["Specific change 1", "Specific change 2", "Specific change 3"],
  "rationale": "Technical reasoning for these changes...",
  "impact_and_tests": "Systems affected and testing recommendations...",
  "next_steps": ["Action item 1", "Action item 2"],
  "tags": "component1, component2, category, technology"
}

Ensure all required fields are present with appropriate content.
</output_format>

<final_instruction>
Based on the commit information provided above, generate the analysis report in valid JSON format now.
</final_instruction>`;

    if (config.security.redactBeforeSend) {
        prompt = redactSecrets(prompt);
    }

    return prompt;
}
