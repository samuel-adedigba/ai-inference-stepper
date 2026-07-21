import { Request, Response, NextFunction } from 'express';
import { logger } from '../../logging.js';
import crypto from 'crypto';

interface CommitReportCompletionPayload {
  jobId: string;
  status: 'completed' | 'failed';
  commitId?: number;
  repoId?: number;
  userId?: string;
  commitSha?: string;
  result?: unknown;
  error?: string;
  timestamp: number;
}

function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

/**
 * CommitDiary compatibility webhook endpoint.
 *
 * TODO: refactor: move this integration out of the generic Stepper package
 * into CommitDiary API package once preset-only bridge migration is complete.
 */
export async function handleCommitReportWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const signature = req.headers['x-webhook-signature'] as string;
    const timestamp = req.headers['x-webhook-timestamp'] as string;

    if (!signature || !timestamp) {
      return res.status(400).json({
        error: 'Missing required headers: x-webhook-signature, x-webhook-timestamp'
      });
    }

    const webhookTime = parseInt(timestamp, 10);
    const now = Date.now();
    const maxAge = 5 * 60 * 1000;

    if (Math.abs(now - webhookTime) > maxAge) {
      return res.status(400).json({
        error: 'Webhook timestamp is too old or too far in the future'
      });
    }

    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error('WEBHOOK_SECRET environment variable not set');
      return res.status(500).json({
        error: 'Webhook secret not configured'
      });
    }

    const payload = req.body;
    const payloadString = JSON.stringify(payload);

    if (!verifyWebhookSignature(payloadString, signature, webhookSecret)) {
      logger.warn({ signature, timestamp }, 'Invalid webhook signature');
      return res.status(401).json({
        error: 'Invalid webhook signature'
      });
    }

    const reportPayload: CommitReportCompletionPayload = payload;
    if (!reportPayload.jobId || !reportPayload.status) {
      return res.status(400).json({
        error: 'Invalid payload: missing jobId or status'
      });
    }

    logger.info({
      jobId: reportPayload.jobId,
      status: reportPayload.status,
      commitId: reportPayload.commitId,
      repoId: reportPayload.repoId
    }, 'Received commit-report completion webhook');

    if (reportPayload.status === 'completed' && reportPayload.commitId && reportPayload.repoId) {
      try {
        const apiUrl = process.env.API_URL || 'http://localhost:3001';
        const apiKey = process.env.WEBHOOK_SECRET;

        if (!apiKey) {
          logger.error('WEBHOOK_SECRET environment variable not set');
          throw new Error('Webhook secret not configured');
        }

        const updateResponse = await fetch(`${apiUrl}/v1/internal/update-commit-status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'X-Internal-Request': 'stepper-webhook'
          },
          body: JSON.stringify({
            commitId: reportPayload.commitId,
            repoId: reportPayload.repoId,
            status: 'completed',
            jobId: reportPayload.jobId,
            result: reportPayload.result
          })
        });

        if (!updateResponse.ok) {
          const errorText = await updateResponse.text();
          logger.error({
            jobId: reportPayload.jobId,
            status: updateResponse.status,
            error: errorText
          }, 'Failed to update main API database');
        } else {
          logger.info({
            jobId: reportPayload.jobId,
            commitId: reportPayload.commitId,
            repoId: reportPayload.repoId
          }, 'Successfully updated database with completed report');
        }
      } catch (updateError) {
        logger.error({
          jobId: reportPayload.jobId,
          error: updateError instanceof Error ? updateError.message : String(updateError)
        }, 'Error updating main API database');
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Webhook processed successfully'
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error)
    }, 'Error processing webhook');

    return next(error);
  }
}
