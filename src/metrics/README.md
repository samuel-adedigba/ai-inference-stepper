# Observability & Metrics

Stepper emits Prometheus metrics for inference reliability and cost-control visibility.

## Goals

- track provider success/failure and latency
- monitor cache effectiveness
- inspect queue/system pressure
- support alerting and SLO dashboards

## Core metric families

| Metric | Type | Purpose |
|---|---|---|
| `ai_requests_total` | Counter | provider request outcomes |
| `ai_request_duration_seconds` | Histogram | provider latency distribution |
| `cache_hits_total` | Counter | fresh/stale cache hit volume |
| `cache_misses_total` | Counter | cache miss volume |
| `provider_failures_total` | Counter | failure category tracking |
| `job_queue_size` | Gauge | queued workload level |

## Endpoint

- exposed via `GET /metrics`
- intended for Prometheus scrape + dashboarding

## Compatibility note

Metrics include low-cardinality `preset` and `response_mode` labels. Keep label dimensions bounded and avoid adding raw request metadata as labels.
