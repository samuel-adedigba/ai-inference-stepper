/**
 * Compatibility shim.
 *
 * CommitDiary webhook integration now lives under presets/commit-report.
 * Keep this re-export during migration so existing imports do not break.
 */
export { handleCommitReportWebhook as handleReportWebhook } from '../presets/commit-report/webhookEndpoint.js';
