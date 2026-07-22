import { CommitReportInput } from '../../types.js';

export const COMPREHENSIVE_EVIDENCE_CHARACTERS = 24_000;
export const SIMPLE_EVIDENCE_CHARACTERS = 8_000;

export function clipInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function clipAtLineBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value.trim();

  const marker = '\n[Evidence sampled: middle content omitted]\n';
  const available = Math.max(0, maxLength - marker.length);
  const headLength = Math.floor(available * 0.7);
  const tailLength = available - headLength;
  const headBreak = value.lastIndexOf('\n', headLength);
  const tailStart = value.indexOf('\n', value.length - tailLength);
  const head = value.slice(0, headBreak > 0 ? headBreak : headLength).trimEnd();
  const tail = value.slice(tailStart >= 0 ? tailStart + 1 : value.length - tailLength).trimStart();

  return `${head}${marker}${tail}`.slice(0, maxLength).trim();
}

/** Keep a broad, deterministic file sample when a commit touches many paths. */
export function selectRepresentativeFiles(files: string[], maxFiles = 80): string[] {
  if (files.length <= maxFiles) return files;

  const tailCount = Math.min(20, Math.floor(maxFiles / 4));
  return [
    ...files.slice(0, maxFiles - tailCount),
    ...files.slice(-tailCount),
  ];
}

/**
 * Fit commit evidence to the provider budget while preserving both the start
 * and end. Extension-generated evidence already spreads excerpts across files.
 */
export function buildCommitEvidence(
  input: CommitReportInput,
  maxLength = COMPREHENSIVE_EVIDENCE_CHARACTERS,
): string {
  const evidence = input.diffSummary.trim();
  if (!evidence) {
    return '[No patch excerpt was captured. Use the commit message and changed-file list only.]';
  }

  return clipAtLineBoundary(evidence, maxLength);
}
