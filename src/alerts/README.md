# Alerts & Notifications

This module emits operational alerts (currently Discord webhook).

## Purpose

- Notify on provider instability
- Notify on circuit breaker events
- Improve incident visibility for inference orchestration

## Current signals

- provider failure streak alerts
- circuit breaker open alerts
- transport errors for alert delivery itself

## Configuration

Set `DISCORD_WEBHOOK_URL` to enable alert delivery.
If unset, Stepper logs locally and skips external notifications.

## Compatibility note

CommitDiary-specific wording/formatting should stay in CommitDiary integration layers. Core alert helpers should remain generic and reusable across use cases.
