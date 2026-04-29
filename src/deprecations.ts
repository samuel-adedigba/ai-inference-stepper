/**
 * Legacy CommitDiary API deprecation plan.
 *
 * TODO: verify — align these milestones with actual npm release cadence
 * before announcing removal in public changelog.
 */
export const LEGACY_COMMIT_REPORT_API_DEPRECATION = {
  announcedIn: 'v1.2.0',
  softDeprecationDate: '2026-05-15',
  removalTarget: 'v2.0.0',
  replacementApis: {
    enqueueReport: 'enqueueRequest(createCommitReportRequest(input))',
    generateReport: 'generateRequest(createCommitReportRequest(input))',
    deleteReport: 'delete by preset cache key helper + generic cache lifecycle',
  },
} as const;
