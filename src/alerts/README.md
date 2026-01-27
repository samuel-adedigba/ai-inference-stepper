# 🔔 Alerts & Notifications

This module handles communicating critical system events to external channels, primarily **Discord**.

## 🎯 Purpose

- **Observability**: Know when the system is struggling in real-time.
- **Incident Response**: Get notified immediately if all AI providers fail or if a circuit breaker opens.

## 🚀 Features

### Discord Integration

Sends rich, formatted "embed" messages to a Discord webhook.

**What gets alerted?**

- **Circuit Breaker Open**: When a provider enters a failed state.
- **Circuit Breaker Closed**: When a provider recovers.
- **Job Failures**: When all providers fail and the system falls back to a template.
- **System Errors**: Unexpected crashes or critical configuration issues.

## 🛠️ Configuration

Set the `DISCORD_WEBHOOK_URL` in your `.env` to enable these alerts. If not set, the system will gracefully skip alerting and only log to the console.
