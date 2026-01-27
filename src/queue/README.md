# 📥 Async Job Queue

AI generation is slow (it can take 30-60 seconds). To keep the application responsive, the **Inference Stepper** uses a background job queue powered by **BullMQ** and **Redis**.

## 🎯 Purpose

- **Responsiveness**: Users get an immediate "Job Enqueued" response instead of waiting for the AI.
- **Reliability**: If a job fails due to a temporary glitch, it can be retried automatically.
- **Concurrency Control**: We can limit how many AI requests run at the same time to avoid hitting global rate limits.

## 👥 Major Organs

### 1. Producer (`producer.ts`)

The "Cashier" of the system.

- Takes the incoming request.
- Assigns a unique `jobId`.
- Puts the task into the Redis queue.
- Returns the `jobId` to the caller.

### 2. Worker (`worker.ts`)

The "Kitchen Staff" who does the actual work.

- Sits in the background and waits for jobs.
- Picks up a job when one is available.
- Calls the **Orchestrator** to do the AI inference.
- Updates the cache with the final result.

## 📋 Functions

| Function             | Role                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `enqueueReportJob()` | Adds a new report request to the queue.                           |
| `getJobStatus()`     | Checks if a job is `waiting`, `active`, `completed`, or `failed`. |
| `processReportJob()` | The internal logic the worker runs for every ticket.              |

## 🚀 Scaling

This architecture allows for **horizontal scaling**. You can run one instance of the API server (Producer) and ten instances of the Worker on different machines to handle high traffic, all sharing the same Redis queue.
