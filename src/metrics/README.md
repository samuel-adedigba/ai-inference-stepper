# 📊 Observability & Metrics

The **Inference Stepper** provides deep insight into its internal operations via **Prometheus** metrics.

## 🎯 Purpose

- **Health Monitoring**: Track provider success rates and latencies.
- **Capacity Planning**: Monitor job queue sizes and cache hit ratios.
- **Alerting**: Provide the data source for the Discord alert system.

## 🚀 Key Metrics Tracked

| Metric                        | Type      | Description                                                       |
| ----------------------------- | --------- | ----------------------------------------------------------------- |
| `ai_requests_total`           | Counter   | Total requests per provider and status (success/fail).            |
| `ai_request_duration_seconds` | Histogram | How long each provider takes to respond.                          |
| `cache_hits_total`            | Counter   | Number of fresh and stale cache hits.                             |
| `cache_misses_total`          | Counter   | Number of requests that weren't in the cache.                     |
| `provider_failures_total`     | Counter   | Detailed breakdown of why providers failed (timeout, auth, etc.). |
| `job_queue_size`              | Gauge     | How many jobs are waiting in the queue.                           |

## 🛠️ Usage

Metrics are exposed at the `/metrics` endpoint if the HTTP server is running. These can be scraped by a Prometheus server and visualized in **Grafana**.
