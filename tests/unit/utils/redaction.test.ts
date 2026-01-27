import { describe, it, expect } from 'vitest';
import { redactSecrets, redactObject } from '../../../src/utils/redaction.js';

describe('Redaction Utils', () => {
    describe('redactSecrets', () => {
        it('should return empty string for empty input', () => {
            expect(redactSecrets('')).toBe('');
        });

        it('should return null/undefined as-is', () => {
            expect(redactSecrets(null as any)).toBe(null);
            expect(redactSecrets(undefined as any)).toBe(undefined);
        });

        it('should redact AWS access keys', () => {
            const input = 'Access key: AKIAIOSFODNN7EXAMPLE';
            const result = redactSecrets(input);
            expect(result).toContain('[REDACTED_AWS_KEY]');
            expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
        });

        it('should redact email addresses', () => {
            const input = 'Contact: user@example.com for help';
            const result = redactSecrets(input);
            expect(result).toContain('[REDACTED_EMAIL]');
            expect(result).not.toContain('user@example.com');
        });

        it('should redact password assignments with equals', () => {
            const input = 'password=my_secret_password123';
            const result = redactSecrets(input);
            expect(result).toContain('password=');
            expect(result).toContain('[REDACTED]');
            expect(result).not.toContain('my_secret_password123');
        });

        it('should redact api_key assignments with equals', () => {
            const input = 'api_key=abc123xyz789';
            const result = redactSecrets(input);
            expect(result).toContain('[REDACTED]');
        });

        it('should preserve short strings that look normal', () => {
            const input = 'This is a normal commit message';
            const result = redactSecrets(input);
            expect(result).toBe(input);
        });

        it('should preserve commit SHAs (40 chars)', () => {
            const sha = 'a'.repeat(40);
            const result = redactSecrets(`Commit: ${sha}`);
            expect(result).toContain(sha);
        });

        it('should redact long token-like strings', () => {
            // Create a string that looks like a token (32+ chars, alphanumeric)
            const token = 'abcdefghijklmnopqrstuvwxyz123456'; // 32 chars
            const input = `Token: ${token}`;
            const result = redactSecrets(input);
            // The pattern matches this as a password-style assignment
            expect(result).toContain('[REDACTED]');
        });

        it('should handle text with multiple sensitive items', () => {
            const input = 'email: admin@company.org, password=secret123';
            const result = redactSecrets(input);
            expect(result).toContain('[REDACTED_EMAIL]');
            expect(result).not.toContain('admin@company.org');
        });
    });

    describe('redactObject', () => {
        it('should redact password field', () => {
            const input = {
                username: 'admin',
                password: 'supersecret',
            };

            const result = redactObject(input);

            expect(result.username).toBe('admin');
            expect(result.password).toBe('[REDACTED]');
        });

        it('should redact secret field', () => {
            const input = {
                secret: 'my-secret-value',
                public: 'not-secret',
            };

            const result = redactObject(input);

            expect(result.secret).toBe('[REDACTED]');
            expect(result.public).toBe('not-secret');
        });

        it('should redact authorization field', () => {
            const input = {
                authorization: 'Bearer token123',
                userId: 'user123',
            };

            const result = redactObject(input);

            expect(result.authorization).toBe('[REDACTED]');
            expect(result.userId).toBe('user123');
        });

        it('should redact secret patterns in string values', () => {
            const input = {
                config: 'password=mydbpass123',
                description: 'Normal text description',
            };

            const result = redactObject(input);

            expect(result.config).toContain('[REDACTED]');
            expect(result.description).toBe('Normal text description');
        });

        it('should preserve non-string, non-sensitive values', () => {
            const input = {
                count: 42,
                enabled: true,
                items: ['a', 'b', 'c'],
            };

            const result = redactObject(input);

            expect(result.count).toBe(42);
            expect(result.enabled).toBe(true);
            expect(result.items).toEqual(['a', 'b', 'c']);
        });

        it('should handle empty object', () => {
            const result = redactObject({});
            expect(result).toEqual({});
        });
    });
});
