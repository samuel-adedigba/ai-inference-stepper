import crypto from 'crypto';
import { CommitReportInput } from '../../types.js';
import { config } from '../../config.js';

/**
 * CommitDiary compatibility cache key builder.
 *
 * This helper intentionally remains preset-scoped because it depends on
 * commit-specific identity fields (`userId`, `commitSha`, `template`).
 */
export function buildCommitReportCacheKey(input: CommitReportInput): string {
  return buildCommitReportCacheKeyFromParts(input.userId, input.commitSha, input.template);
}

/**
 * Helper for compatibility paths that only have report identity fields.
 */
export function buildCommitReportCacheKeyFromParts(
  userId: string,
  commitSha: string,
  template?: string
): string {
  const templateHash = computeTemplateHash(template);
  return `${config.redis.keyPrefix}report:${userId}:${commitSha}:${templateHash}`;
}

/**
 * Kept separate so delete/report compatibility routes can derive the same key.
 */
export function computeTemplateHash(template?: string): string {
  const templateStr = template || 'default';
  return crypto.createHash('sha256').update(templateStr).digest('hex').slice(0, 16);
}
