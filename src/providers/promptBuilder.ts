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

3. **changes** (array of strings, max 50 items):
   - List specific, concrete changes made in this commit
   - Each item should be one clear, atomic change
   - Format: "Added X to Y", "Modified Z in W", "Removed A from B"
   - Focus on WHAT changed, not why (the why goes in rationale)
   - Examples:
     * "Added validateToken() function to auth.ts"
     * "Modified user login flow to include token refresh"
     * "Removed deprecated session handling code"
   - Be specific with file names and function names when relevant

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
- changes: Array of specific changes made
- rationale: Why these changes were needed
- impact_and_tests: Impact analysis and testing needs
- next_steps: Array of follow-up tasks
- tags: Comma-separated relevant tags

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