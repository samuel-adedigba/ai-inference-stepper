// packages/stepper/src/webhooks/delivery.ts

import crypto from 'crypto';
import { logger, createChildLogger } from '../logging.js';

export interface WebhookPayload {
    jobId: string;
    status: 'completed' | 'failed';
    result?: unknown;
    error?: string;
    timestamp: number;
}

export interface WebhookConfig {
    url: string;
    secret: string;
    maxRetries?: number;
    retryDelayMs?: number;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
function generateSignature(payload: string, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
}

/**
 * Send webhook notification with bearer token + HMAC signature
 * Implements retry logic for failed deliveries
 */
export async function sendWebhook(
    config: WebhookConfig,
    payload: WebhookPayload,
    attempt: number = 1
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const log = createChildLogger({ jobId: payload.jobId, webhookAttempt: attempt });

    const maxRetries = config.maxRetries || 3;
    const retryDelayMs = config.retryDelayMs || 5000;

    try {
        const payloadString = JSON.stringify(payload);
        const signature = generateSignature(payloadString, config.secret);

        log.info({ url: config.url, attempt, maxRetries }, 'Sending webhook');

        const response = await fetch(config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.secret}`,
                'X-Webhook-Signature': signature,
                'X-Webhook-Timestamp': payload.timestamp.toString(),
                'User-Agent': 'Stepper/1.0'
            },
            body: payloadString,
            signal: AbortSignal.timeout(10000) // 10s timeout
        });

        if (response.ok) {
            log.info({ statusCode: response.status }, 'Webhook delivered successfully');
            return { success: true, statusCode: response.status };
        }

        // Non-OK response
        const errorBody = await response.text().catch(() => 'Unable to read response');
        log.warn({ statusCode: response.status, errorBody }, 'Webhook delivery failed with non-OK status');

        // Retry on 5xx errors or specific 4xx errors
        const shouldRetry = response.status >= 500 || response.status === 408 || response.status === 429;

        if (shouldRetry && attempt < maxRetries) {
            log.info({ nextAttempt: attempt + 1, delayMs: retryDelayMs }, 'Retrying webhook delivery');
            await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt)); // Exponential backoff
            return sendWebhook(config, payload, attempt + 1);
        }

        return {
            success: false,
            statusCode: response.status,
            error: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage, attempt }, 'Webhook delivery error');

        // Retry on network errors
        if (attempt < maxRetries) {
            log.info({ nextAttempt: attempt + 1, delayMs: retryDelayMs }, 'Retrying webhook after error');
            await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
            return sendWebhook(config, payload, attempt + 1);
        }

        return {
            success: false,
            error: `Network error after ${maxRetries} attempts: ${errorMessage}`
        };
    }
}

/**
 * Send success webhook notification
 */
export async function notifyWebhookSuccess(
    webhookUrl: string,
    webhookSecret: string,
    jobId: string,
    result: unknown
): Promise<void> {
    const payload: WebhookPayload = {
        jobId,
        status: 'completed',
        result,
        timestamp: Date.now()
    };

    const webhookResult = await sendWebhook(
        { url: webhookUrl, secret: webhookSecret },
        payload
    );

    if (!webhookResult.success) {
        logger.warn(
            { jobId, error: webhookResult.error },
            'Webhook delivery failed after all retries - job completed but notification not delivered'
        );
    }
}

/**
 * Send failure webhook notification
 */
export async function notifyWebhookFailure(
    webhookUrl: string,
    webhookSecret: string,
    jobId: string,
    error: string
): Promise<void> {
    const payload: WebhookPayload = {
        jobId,
        status: 'failed',
        error,
        timestamp: Date.now()
    };

    const webhookResult = await sendWebhook(
        { url: webhookUrl, secret: webhookSecret },
        payload
    );

    if (!webhookResult.success) {
        logger.warn(
            { jobId, error: webhookResult.error },
            'Failure webhook delivery failed - job failed and notification not delivered'
        );
    }
}
