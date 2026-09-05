// `packages/stepper/src/alerts/discord.ts

import { logger } from '../logging.js';
import axios from 'axios';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

export interface DiscordAlert {
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    metadata?: Record<string, unknown>;
}

/**
 * Send alert to Discord webhook
 */
export async function sendDiscordAlert(alert: DiscordAlert): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) {
        logger.debug('Discord webhook URL not configured, skipping alert');
        return;
    }

    const emoji = alert.severity === 'critical' ? '🚨' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
    const content = `${emoji} **${alert.title}**\n${alert.message}`;

    const embed = alert.metadata
        ? {
            embeds: [
                {
                    title: alert.title,
                    description: alert.message,
                    color: alert.severity === 'critical' ? 0xff0000 : alert.severity === 'warning' ? 0xffa500 : 0x00ff00,
                    fields: Object.entries(alert.metadata).map(([key, value]) => ({
                        name: key,
                        value: String(value),
                        inline: true,
                    })),
                    timestamp: new Date().toISOString(),
                },
            ],
        }
        : { content };

    try {
        const response = await axios({
            url: DISCORD_WEBHOOK_URL,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: embed,
            timeout: 10_000,
            validateStatus: () => true,
        });

        if (response.status < 200 || response.status >= 300) {
            logger.warn({ status: response.status }, 'Discord webhook request failed');
        }
    } catch {
        logger.error({ errorCode: 'DISCORD_ALERT_ERROR' }, 'Failed to send Discord alert');
    }
}

/**
 * Send provider failure alert
 */
export async function alertProviderFailure(provider: string, errorCount: number, _error?: unknown): Promise<void> {
    await sendDiscordAlert({
        title: 'AI Provider Failure',
        message: `Provider **${provider}** has failed ${errorCount} times.`,
        severity: errorCount >= 5 ? 'critical' : 'warning',
        metadata: { provider, errorCount, timestamp: new Date().toISOString() },
    });
}

/**
 * Send circuit breaker alert
 */
export async function alertCircuitOpen(provider: string, _lastError?: unknown): Promise<void> {
    await sendDiscordAlert({
        title: 'Circuit Breaker Opened',
        message: `Circuit breaker for provider **${provider}** is now OPEN.`,
        severity: 'critical',
        metadata: { provider, timestamp: new Date().toISOString() },
    });
}
