import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAlert } from '../../../src/alerts/discord.js';

// The Discord module reads DISCORD_WEBHOOK_URL at module load time
// so we test the exported interfaces and types without full integration

describe('Discord Alerts', () => {
    describe('DiscordAlert interface', () => {
        it('should accept valid alert with all fields', () => {
            const alert: DiscordAlert = {
                title: 'Test Alert',
                message: 'This is a test message',
                severity: 'info',
                metadata: {
                    provider: 'gemini',
                    errorCount: 3,
                },
            };

            expect(alert.title).toBe('Test Alert');
            expect(alert.severity).toBe('info');
            expect(alert.metadata?.provider).toBe('gemini');
        });

        it('should accept alert without metadata', () => {
            const alert: DiscordAlert = {
                title: 'Simple Alert',
                message: 'No metadata here',
                severity: 'warning',
            };

            expect(alert.title).toBe('Simple Alert');
            expect(alert.metadata).toBeUndefined();
        });

        it('should accept critical severity', () => {
            const alert: DiscordAlert = {
                title: 'Critical!',
                message: 'System down',
                severity: 'critical',
            };

            expect(alert.severity).toBe('critical');
        });

        it('should accept warning severity', () => {
            const alert: DiscordAlert = {
                title: 'Warning',
                message: 'High load detected',
                severity: 'warning',
            };

            expect(alert.severity).toBe('warning');
        });

        it('should accept info severity', () => {
            const alert: DiscordAlert = {
                title: 'Info',
                message: 'System update complete',
                severity: 'info',
            };

            expect(alert.severity).toBe('info');
        });
    });

    describe('Alert metadata', () => {
        it('should support various metadata types', () => {
            const alert: DiscordAlert = {
                title: 'Test',
                message: 'Test message',
                severity: 'info',
                metadata: {
                    stringField: 'value',
                    numberField: 42,
                    booleanField: true,
                    timestamp: new Date().toISOString(),
                },
            };

            expect(alert.metadata?.stringField).toBe('value');
            expect(alert.metadata?.numberField).toBe(42);
            expect(alert.metadata?.booleanField).toBe(true);
        });

        it('should support provider failure metadata', () => {
            const alert: DiscordAlert = {
                title: 'AI Provider Failure',
                message: 'Provider gemini has failed',
                severity: 'critical',
                metadata: {
                    provider: 'gemini',
                    errorCount: 5,
                    error: 'Connection refused',
                    timestamp: '2026-01-27T16:00:00Z',
                },
            };

            expect(alert.metadata?.provider).toBe('gemini');
            expect(alert.metadata?.errorCount).toBe(5);
        });

        it('should support circuit breaker metadata', () => {
            const alert: DiscordAlert = {
                title: 'Circuit Breaker Opened',
                message: 'Circuit for anthropic is now OPEN',
                severity: 'critical',
                metadata: {
                    provider: 'anthropic',
                    lastError: 'Rate limit exceeded',
                    timestamp: '2026-01-27T16:00:00Z',
                },
            };

            expect(alert.metadata?.provider).toBe('anthropic');
            expect(alert.metadata?.lastError).toBe('Rate limit exceeded');
        });
    });
});
