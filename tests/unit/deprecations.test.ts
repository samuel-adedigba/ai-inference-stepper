import { describe, expect, it } from 'vitest';
import { LEGACY_COMMIT_REPORT_API_DEPRECATION } from '../../src/deprecations.js';

describe('Legacy API deprecations', () => {
  it('should expose migration timeline for legacy CommitDiary wrappers', () => {
    expect(LEGACY_COMMIT_REPORT_API_DEPRECATION.announcedIn).toBeTruthy();
    expect(LEGACY_COMMIT_REPORT_API_DEPRECATION.softDeprecationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(LEGACY_COMMIT_REPORT_API_DEPRECATION.removalTarget).toBe('v2.0.0');
    expect(LEGACY_COMMIT_REPORT_API_DEPRECATION.replacementApis.enqueueReport).toContain('enqueueRequest');
  });
});
