// packages/stepper/src/webhooks/delivery.ts

import crypto from 'crypto';
import axios from 'axios';
import { logger, createChildLogger } from '../logging.js';
import { getCallbackLogOrigin, isAllowedCallbackUrl } from '../security/callbackUrls.js';

export interface WebhookPayload {
    jobId: string;
    status: 'completed' | 'failed';
    result?: unknown;
    error?: string;
    provider?: string;
    generationTimeMs?: number;
    fallback?: boolean;
    timestamp: number;
}

export interface WebhookConfig {
    url: string;
    secret: string;
    maxRetries?: number;
    retryDelayMs?: number;
    axiosImpl?: typeof axios;
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

    if (!isAllowedCallbackUrl(config.url)) {
        return { success: false, error: 'Webhook URL origin is not allowed' };
    }

    const maxRetries = Math.min(Math.max(Number(config.maxRetries ?? 3) || 3, 1), 5);
    const retryDelayMs = Math.min(Math.max(Number(config.retryDelayMs ?? 5000) || 0, 0), 60_000);

    try {
        const payloadString = JSON.stringify(payload);
        const signature = generateSignature(payloadString, config.secret);

        log.info({ callbackOrigin: getCallbackLogOrigin(config.url), attempt, maxRetries }, 'Sending webhook');

        const response = await (config.axiosImpl ?? axios)({
            url: config.url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.secret}`,
                'X-Webhook-Signature': signature,
                'X-Webhook-Timestamp': payload.timestamp.toString(),
                'User-Agent': 'Stepper/1.0'
            },
            data: payloadString,
            timeout: 10_000,
            maxRedirects: 0,
            validateStatus: () => true,
        });

        if (response.status >= 200 && response.status < 300) {
            log.info({ statusCode: response.status }, 'Webhook delivered successfully');
            return { success: true, statusCode: response.status };
        }

        // Non-OK response
        log.warn({ statusCode: response.status, errorCode: 'WEBHOOK_HTTP_ERROR' }, 'Webhook delivery failed with non-OK status');

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
            error: `Webhook returned HTTP ${response.status}`
        };

    } catch (error) {
        log.error({ errorCode: 'WEBHOOK_NETWORK_ERROR', attempt }, 'Webhook delivery error');

        // Retry on network errors
        if (attempt < maxRetries) {
            log.info({ nextAttempt: attempt + 1, delayMs: retryDelayMs }, 'Retrying webhook after error');
            await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
            return sendWebhook(config, payload, attempt + 1);
        }

        return {
            success: false,
            error: `Webhook network error after ${maxRetries} attempts`
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
    result: unknown,
    metadata: { provider?: string; generationTimeMs?: number; fallback?: boolean } = {},
    axiosImpl: typeof axios = axios,
): Promise<void> {
    const payload: WebhookPayload = {
        jobId,
        status: 'completed',
        result,
        provider: metadata.provider,
        generationTimeMs: metadata.generationTimeMs,
        fallback: metadata.fallback,
        timestamp: Date.now()
    };

    const webhookResult = await sendWebhook(
        { url: webhookUrl, secret: webhookSecret, axiosImpl },
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
    error: string,
    axiosImpl: typeof axios = axios,
): Promise<void> {
    const payload: WebhookPayload = {
        jobId,
        status: 'failed',
        error,
        timestamp: Date.now()
    };

    const webhookResult = await sendWebhook(
        { url: webhookUrl, secret: webhookSecret, axiosImpl },
        payload
    );

    if (!webhookResult.success) {
        logger.warn(
            { jobId, error: webhookResult.error },
            'Failure webhook delivery failed - job failed and notification not delivered'
        );
    }
}
