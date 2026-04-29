import { CommitReportInput, CommitReportOutput } from '../../types.js';

/**
 * CommitDiary preset fallback report generator.
 *
 * This fallback is intentionally commit-shaped and should remain in the
 * commit-report preset boundary, not the generic Stepper core runtime.
 */
export function generateCommitReportFallback(input: CommitReportInput): CommitReportOutput {
  const { message, files, components, diffSummary, repo } = input;

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
