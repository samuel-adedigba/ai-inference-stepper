import { PromptInput, ReportOutput } from '../types.js';

/**
 * Generate a deterministic, template-based fallback report
 * Used when all AI providers fail
 */
export function generateTemplateFallback(input: PromptInput): ReportOutput {
  const { message, files, components, diffSummary, repo } = input;

  // Extract basic info from commit message
  const firstLine = message.split('\n')[0] || 'Code changes';
  const fileCount = files.length;
  const componentCount = components.length;

  return {
    title: `${firstLine.slice(0, 80)}`,
    summary: `This commit modifies ${fileCount} file${fileCount !== 1 ? 's' : ''} in ${repo}. ` +
      `The changes affect ${componentCount} component${componentCount !== 1 ? 's' : ''}. ` +
      `Commit message: "${message.slice(0, 200)}${message.length > 200 ? '...' : ''}"`,
    changes: files.slice(0, 10).map((f) => `Modified ${f}`),
    rationale: `Automated fallback: Unable to generate AI-powered analysis. ` +
      `Diff summary: ${diffSummary.slice(0, 300)}${diffSummary.length > 300 ? '...' : ''}`,
    impact_and_tests: `Please review the changes manually. Ensure tests are updated for modified files: ${files.slice(0, 5).join(', ')}`,
    next_steps: [
      'Review changes manually',
      'Run test suite',
      'Verify component integration',
      'Update documentation if needed',
    ],
    tags: components.slice(0, 5).join(', ') || 'general',
  };
}