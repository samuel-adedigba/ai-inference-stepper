import { CommitReportInput } from '../types.js';
import {
  buildCommitReportComprehensivePrompt,
  buildCommitReportGeminiPrompt,
  buildCommitReportPrompt,
  buildCommitReportSimplePrompt,
} from '../presets/commit-report/prompt.js';

/**
 * Compatibility shim.
 *
 * The prompt builder implementation has moved to:
 * `presets/commit-report/prompt.ts`
 *
 * Keep these exports temporarily so existing imports do not break while
 * Phase 5+ migration removes provider-level prompt construction callsites.
 */
export function buildComprehensivePrompt(input: CommitReportInput): string {
  return buildCommitReportComprehensivePrompt(input);
}

export function buildSimplePrompt(input: CommitReportInput): string {
  return buildCommitReportSimplePrompt(input);
}

export function buildGeminiPrompt(input: CommitReportInput): string {
  return buildCommitReportGeminiPrompt(input);
}

export function buildCustomPrompt(
  input: CommitReportInput,
  customInstructions?: string
): string {
  return buildCommitReportPrompt(input, { customInstructions, mode: 'comprehensive' });
}

