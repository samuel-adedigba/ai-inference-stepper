import {
  CommitReportInput,
  PromptBuilderInput,
  StepperPrompt,
  StepperRequest,
} from '../types.js';
import { buildCommitReportPrompt, CommitReportPromptMode } from '../presets/commit-report/prompt.js';
import { COMMIT_REPORT_PRESET } from '../presets/commit-report/request.js';
import { config } from '../config.js';
import { redactSecrets } from '../utils/redaction.js';

type PlaceholderMap = Record<string, unknown>;

type PromptRenderContext<TPayload = unknown> = {
  payload?: TPayload;
  metadata?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  commitMode?: CommitReportPromptMode;
};

/**
 * Resolve dotted path values for template interpolation (e.g. payload.repo.name).
 */
function getValueByPath(source: PlaceholderMap, path: string): unknown {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  let current: unknown = source;

  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function interpolateTemplate(template: string, placeholders: PlaceholderMap): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawPath: string) => {
    const value = getValueByPath(placeholders, rawPath);
    if (value === undefined || value === null) {
      return '';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function stringifyFallback(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error('Rendered prompt is empty. Provide a non-empty prompt or template.');
  }

  if (config.security.redactBeforeSend) {
    return redactSecrets(trimmed);
  }

  return trimmed;
}

function isPromptBuilderInput<TPayload = unknown>(
  prompt: StepperPrompt<TPayload>
): prompt is PromptBuilderInput<TPayload> {
  return typeof prompt === 'object' && prompt !== null;
}

function isCommitReportInput(value: unknown): value is CommitReportInput {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const input = value as Partial<CommitReportInput>;
  return (
    typeof input.userId === 'string' &&
    typeof input.commitSha === 'string' &&
    typeof input.repo === 'string' &&
    typeof input.message === 'string' &&
    Array.isArray(input.files) &&
    Array.isArray(input.components) &&
    typeof input.diffSummary === 'string'
  );
}

function resolveGenericPromptFromBuilder<TPayload>(
  input: PromptBuilderInput<TPayload>,
  context: PromptRenderContext<TPayload>
): string {
  const placeholders: PlaceholderMap = {
    payload: context.payload,
    metadata: context.metadata,
    variables: {
      ...(context.variables || {}),
      ...(input.variables || {}),
    },
  };

  if (input.template && input.template.trim().length > 0) {
    const renderedTemplate = interpolateTemplate(input.template, placeholders);
    if (input.instructions && input.instructions.trim().length > 0) {
      return sanitizePrompt(`${input.instructions.trim()}\n\n${renderedTemplate}`);
    }
    return sanitizePrompt(renderedTemplate);
  }

  if (input.instructions && input.instructions.trim().length > 0) {
    const payloadSuffix = stringifyFallback(context.payload);
    const composed = payloadSuffix
      ? `${input.instructions.trim()}\n\nContext payload:\n${payloadSuffix}`
      : input.instructions.trim();
    return sanitizePrompt(composed);
  }

  // TODO: caution: this fallback is intentionally generic and may be too raw for
  // high-quality production prompts. Add richer generic prompt presets in later phases.
  return sanitizePrompt(stringifyFallback(context.payload));
}

/**
 * Render final prompt string from generic Stepper prompt contracts.
 */
export function renderPrompt<TPayload = unknown>(
  prompt: StepperPrompt<TPayload>,
  context: PromptRenderContext<TPayload> = {}
): string {
  if (typeof prompt === 'string') {
    return sanitizePrompt(prompt);
  }

  if (!isPromptBuilderInput(prompt)) {
    throw new Error('Unsupported prompt shape.');
  }

  if (prompt.preset === COMMIT_REPORT_PRESET) {
    const commitInput = (context.payload || prompt.payload) as CommitReportInput | undefined;
    if (!commitInput || !isCommitReportInput(commitInput)) {
      throw new Error('commit-report preset requires CommitReportInput payload.');
    }

    return buildCommitReportPrompt(commitInput, {
      mode: context.commitMode || 'comprehensive',
      customInstructions: prompt.instructions,
    });
  }

  return resolveGenericPromptFromBuilder(prompt, context);
}

/**
 * Render provider-ready prompt from generic Stepper requests.
 */
export function renderProviderPrompt(
  request: StepperRequest<unknown, unknown>,
  options: { providerName: string; useSimplePrompt?: boolean }
): string {
  const mode: CommitReportPromptMode = options.providerName === 'gemini'
    ? 'gemini'
    : options.useSimplePrompt
      ? 'simple'
      : 'comprehensive';

  return renderPrompt(request.prompt, {
    payload: request.payload,
    metadata: request.metadata,
    commitMode: mode,
  });
}
