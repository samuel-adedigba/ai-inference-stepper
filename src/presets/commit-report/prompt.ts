import { CommitReportInput } from '../../types.js';
import { redactSecrets } from '../../utils/redaction.js';
import { config } from '../../config.js';
import {
  buildCommitEvidence,
  clipInline,
  COMPREHENSIVE_EVIDENCE_CHARACTERS,
  selectRepresentativeFiles,
  SIMPLE_EVIDENCE_CHARACTERS,
} from './evidence.js';

export type CommitReportPromptMode = 'comprehensive' | 'simple' | 'gemini';

/**
 * Build a comprehensive, detailed prompt for CommitDiary report generation.
 */
export function buildCommitReportComprehensivePrompt(input: CommitReportInput): string {
  const representativeFiles = selectRepresentativeFiles(input.files, 60)
    .map((file) => clipInline(file, 160));
  const representativeComponents = selectRepresentativeFiles(input.components, 40)
    .map((component) => clipInline(component, 80));
  const evidence = buildCommitEvidence(input, COMPREHENSIVE_EVIDENCE_CHARACTERS);
  let prompt = `You are a senior software engineer analyzing a code commit. Your task is to generate a structured, professional commit report in valid JSON format.

## COMMIT INFORMATION
Repository: ${input.repo}
Commit SHA: ${input.commitSha}
Commit Message: ${clipInline(input.message, 3_000)}

Files Changed (${input.files.length} files):
${representativeFiles.map((f, i) => `${i + 1}. ${f}`).join('\n')}
${input.files.length > representativeFiles.length ? `... ${input.files.length - representativeFiles.length} additional paths are covered by the diff statistics` : ''}

Affected Components: ${representativeComponents.join(', ') || 'General'}
${input.components.length > representativeComponents.length ? `... ${input.components.length - representativeComponents.length} additional components omitted from prompt metadata` : ''}

## AVAILABLE COMMIT EVIDENCE
${evidence}

## ANALYSIS INSTRUCTIONS

You MUST analyze the above commit information and produce a JSON object with EXACTLY these fields:

1. **title** (string, max 120 characters):
   - Create a clear, concise title summarizing the main purpose of this commit
   - Format: "[Component] Action taken" (e.g., "Auth: Add token refresh logic")
   - Be specific about WHAT was changed, not just "Updated files"
   - Use active voice and present tense

2. **summary** (string, max 2000 characters):
   - Write 1-3 concise paragraphs explaining the commit's purpose and context
   - First paragraph: What problem does this solve or what feature does it add?
   - Second paragraph: How was it implemented? What approach was taken?
   - Third paragraph (if needed): Any important technical decisions or trade-offs
   - Base your summary ONLY on the commit evidence, message, and file list
   - Do NOT make assumptions about code you cannot see

3. **changes** (array of strings, REQUIRED, minimum 1 item, max 50 items):
   - CRITICAL: This array MUST contain at least one change item
   - List specific, concrete changes made in this commit; normally 3-12 items is enough
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
   - Use the labels "Observed impact:", "Tests changed:", and "Recommended validation:" where applicable
   - Analyze the impact of these changes:
     * Which parts of the system are affected?
     * Are there potential breaking changes?
     * What edge cases should be considered?
   - Identify testing needs:
     * What should be tested (unit tests, integration tests)?
     * Which scenarios need coverage?
     * Are there any test files in the changed files?
   - If test files are present, mention what they appear to test
   - Never claim that tests ran or passed unless the evidence explicitly proves it
   - Be practical and specific about test requirements

6. **next_steps** (array of strings, max 20 items):
   - List actionable follow-up tasks or recommendations
   - Each item should be a clear, specific action
   - Examples:
     * "Update API documentation for new authentication flow"
     * "Add integration tests for token refresh scenario"
     * "Review error handling in edge cases"
     * "Monitor performance impact in production"
   - Prioritize by importance/urgency; normally 0-5 items is enough
   - Only suggest steps that are actually needed based on the changes; do not add generic filler

7. **tags** (string, max 200 characters):
   - Comma-separated list of relevant tags
   - Use component names from the input when applicable
   - Add functional categories: "feature", "bugfix", "refactor", "security", "performance", "documentation"
   - Examples: "auth, security, bugfix" or "api, performance, refactor"
   - Keep it concise and relevant

## CRITICAL REQUIREMENTS

1. **Output ONLY valid JSON** - No markdown, no code blocks, no backticks, no explanatory text
2. **Use ONLY the exact field names** specified above
3. **Base analysis on available evidence** - Do not hallucinate features or changes not shown
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

  if (config.security.redactBeforeSend) {
    prompt = redactSecrets(prompt);
  }

  return prompt;
}

/**
 * Lightweight commit-report prompt used for smaller/faster models.
 */
export function buildCommitReportSimplePrompt(input: CommitReportInput): string {
  const representativeFiles = selectRepresentativeFiles(input.files, 30)
    .map((file) => clipInline(file, 120));
  const representativeComponents = selectRepresentativeFiles(input.components, 20)
    .map((component) => clipInline(component, 60));
  const evidence = buildCommitEvidence(input, SIMPLE_EVIDENCE_CHARACTERS);
  let prompt = `Analyze this code commit and return a JSON report.

Repository: ${input.repo}
Commit: ${input.commitSha}
Message: ${clipInline(input.message, 1_500)}
Files (${input.files.length} total): ${representativeFiles.join(', ')}
Components: ${representativeComponents.join(', ')}

Available commit evidence:
${evidence}

Return valid JSON with these exact fields:
- title: Brief description (under 120 chars)
- summary: What changed and why (2-3 sentences)
- changes: Array of specific changes made (REQUIRED: minimum 1 item)
- rationale: Why these changes were needed
- impact_and_tests: Impact analysis and testing needs
- next_steps: Array of follow-up tasks
- tags: Comma-separated relevant tags

CRITICAL: The "changes" array MUST have at least 1 item.
Do not claim tests ran or passed unless the evidence says so. Use only necessary next steps.
Output ONLY valid JSON, no markdown or extra text.`;

  if (config.security.redactBeforeSend) {
    prompt = redactSecrets(prompt);
  }

  return prompt;
}

/**
 * Gemini-optimized prompt variant using XML tags.
 */
export function buildCommitReportGeminiPrompt(input: CommitReportInput): string {
  const representativeFiles = selectRepresentativeFiles(input.files, 60)
    .map((file) => clipInline(file, 160));
  const representativeComponents = selectRepresentativeFiles(input.components, 40)
    .map((component) => clipInline(component, 80));
  const evidence = buildCommitEvidence(input, COMPREHENSIVE_EVIDENCE_CHARACTERS);
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
Commit Message: ${clipInline(input.message, 3_000)}

Files Changed (${input.files.length} total):
${representativeFiles.map((f, i) => `${i + 1}. ${f}`).join('\n')}
${input.files.length > representativeFiles.length ? `... ${input.files.length - representativeFiles.length} additional paths are covered by the diff statistics` : ''}

Affected Components: ${representativeComponents.join(', ') || 'General'}
${input.components.length > representativeComponents.length ? `... ${input.components.length - representativeComponents.length} additional components omitted from prompt metadata` : ''}

## AVAILABLE COMMIT EVIDENCE
${evidence}
</context>

<task>
Analyze the commit above and generate a structured JSON report with these EXACT fields:

1. **title** (string, max 120 characters)
2. **summary** (string, max 2000 characters)
3. **changes** (array of strings, REQUIRED, minimum 1 item, max 50 items)
4. **rationale** (string, max 2000 characters)
5. **impact_and_tests** (string, max 2000 characters)
6. **next_steps** (array of strings, max 20 items)
7. **tags** (string, max 200 characters)
</task>

<quality_rules>
- Prefer 3-12 concrete change items and 0-5 necessary next steps
- In impact_and_tests, distinguish observed test changes from recommended validation
- Never claim tests ran or passed unless the evidence explicitly says so
- Acknowledge missing evidence instead of guessing
</quality_rules>

<output_format>
Return ONLY a valid JSON object. No markdown code blocks. No backticks. No explanatory text before or after.
CRITICAL: The "changes" array MUST have at least 1 item. Do not return an empty array.
</output_format>

<final_instruction>
Based on the commit information provided above, generate the analysis report in valid JSON format now.
</final_instruction>`;

  if (config.security.redactBeforeSend) {
    prompt = redactSecrets(prompt);
  }

  return prompt;
}

/**
 * Central preset prompt resolver used by generic runtime prompt rendering.
 * Keeping this switch in one place avoids repeating provider-specific variants.
 */
export function buildCommitReportPrompt(
  input: CommitReportInput,
  options?: { mode?: CommitReportPromptMode; customInstructions?: string }
): string {
  const mode = options?.mode || 'comprehensive';

  let prompt: string;
  switch (mode) {
    case 'gemini':
      prompt = buildCommitReportGeminiPrompt(input);
      break;
    case 'simple':
      prompt = buildCommitReportSimplePrompt(input);
      break;
    case 'comprehensive':
    default:
      prompt = buildCommitReportComprehensivePrompt(input);
      break;
  }

  if (options?.customInstructions) {
    return `${prompt}\n\n## ADDITIONAL INSTRUCTIONS\n${options.customInstructions}`;
  }

  return prompt;
}
