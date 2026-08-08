export interface BatchValidationLimits {
    maxItems: number;
    maxConcurrency: number;
}

export interface BatchEnvelopeItem {
    id: string;
    request: Record<string, unknown>;
}

export interface BatchEnvelope {
    tenantId?: string;
    requestId?: string;
    items: BatchEnvelopeItem[];
    concurrency: number;
}

export type BatchEnvelopeValidation =
    | { valid: true; batch: BatchEnvelope }
    | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Validate the transport-independent batch envelope shared by HTTP and the
 * library API. Request-specific schema validation remains at the HTTP layer.
 */
export function validateBatchEnvelope(
    value: unknown,
    limits: BatchValidationLimits,
): BatchEnvelopeValidation {
    if (!isRecord(value)) {
        return { valid: false, error: 'Request body must be an object' };
    }

    if (!Array.isArray(value.items) || value.items.length === 0) {
        return { valid: false, error: 'Batch items must be a non-empty array' };
    }

    if (value.items.length > limits.maxItems) {
        return { valid: false, error: `Batch cannot contain more than ${limits.maxItems} items` };
    }

    const requestedConcurrency = value.concurrency === undefined
        ? limits.maxConcurrency
        : value.concurrency;
    if (typeof requestedConcurrency !== 'number'
        || !Number.isInteger(requestedConcurrency)
        || requestedConcurrency < 1
        || requestedConcurrency > limits.maxConcurrency) {
        return { valid: false, error: `Invalid concurrency: expected an integer from 1 to ${limits.maxConcurrency}` };
    }

    const ids = new Set<string>();
    const items: BatchEnvelopeItem[] = [];
    for (let index = 0; index < value.items.length; index += 1) {
        const rawItem = value.items[index];
        if (!isRecord(rawItem)
            || typeof rawItem.id !== 'string'
            || rawItem.id.trim().length === 0
            || rawItem.id.length > 128
            || !isRecord(rawItem.request)) {
            return {
                valid: false,
                error: `Invalid items[${index}]: expected an object with a unique id and request object`,
            };
        }

        const id = rawItem.id.trim();
        if (ids.has(id)) {
            return { valid: false, error: `Batch item IDs must be unique (duplicate: '${id}')` };
        }
        ids.add(id);
        items.push({ id, request: rawItem.request });
    }

    const tenantId = value.tenantId === undefined ? undefined : value.tenantId;
    const requestId = value.requestId === undefined ? undefined : value.requestId;
    if (tenantId !== undefined && (typeof tenantId !== 'string' || tenantId.length > 256)) {
        return { valid: false, error: 'Invalid tenantId: expected a string up to 256 characters' };
    }
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 256)) {
        return { valid: false, error: 'Invalid requestId: expected a string up to 256 characters' };
    }

    return {
        valid: true,
        batch: {
            tenantId: tenantId as string | undefined,
            requestId: requestId as string | undefined,
            items,
            concurrency: requestedConcurrency,
        },
    };
}
