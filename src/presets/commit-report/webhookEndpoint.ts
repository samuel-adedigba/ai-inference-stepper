import { Request, Response, NextFunction } from 'express';
import { logger } from '../../logging.js';
import crypto from 'crypto';
import axios from 'axios';

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

  if (!/^[a-f0-9]+$/i.test(signature) || signature.length !== expectedSignature.length) {
    return false;
  }

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

    const webhookTime = Number.parseInt(timestamp, 10);
    const now = Date.now();
    const maxAge = 5 * 60 * 1000;

    if (!Number.isFinite(webhookTime) || Math.abs(now - webhookTime) > maxAge) {
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
      logger.warn({ timestamp }, 'Invalid webhook signature');
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

        const updateResponse = await axios({
          url: `${apiUrl}/v1/internal/update-commit-status`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'X-Internal-Request': 'stepper-webhook'
          },
          data: {
            commitId: reportPayload.commitId,
            repoId: reportPayload.repoId,
            status: 'completed',
            jobId: reportPayload.jobId,
            result: reportPayload.result
          },
          timeout: 10_000,
          validateStatus: () => true,
        });

        if (updateResponse.status < 200 || updateResponse.status >= 300) {
          logger.error({
            jobId: reportPayload.jobId,
            status: updateResponse.status,
          }, 'Failed to update main API database');
          return res.status(503).json({
            success: false,
            error: 'Webhook processing will be retried',
          });
        } else {
          logger.info({
            jobId: reportPayload.jobId,
            commitId: reportPayload.commitId,
            repoId: reportPayload.repoId
          }, 'Successfully updated database with completed report');
        }
      } catch {
        logger.error({
          jobId: reportPayload.jobId,
          errorCode: 'INTERNAL_COMMIT_STATUS_UPDATE_FAILED',
        }, 'Error updating main API database');
        return res.status(503).json({
          success: false,
          error: 'Webhook processing will be retried',
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Webhook processed successfully'
    });
  } catch (error) {
    logger.error({
      errorCode: 'COMMIT_REPORT_WEBHOOK_FAILED',
    }, 'Error processing webhook');

    return next(error);
  }
}
