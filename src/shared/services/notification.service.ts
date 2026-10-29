import { FastifyInstance } from 'fastify';

export type NotificationType =
  | 'SHIFT_ASSIGNED'
  | 'GPS_FAILURE_ALERT'
  | 'GPS_RECOVERED'
  | 'ATTENDANCE_EXCEPTION'
  | 'CORRECTION_RESOLVED'
  | 'LEAVE_REQUESTED'
  | 'LEAVE_APPROVED'
  | 'LEAVE_REJECTED'
  | 'PAYROLL_READY'
  | 'PAYROLL_APPROVED'
  | 'PAYROLL_PAID';

export interface CreateNotificationInput {
  organizationId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /**
   * Deduplication key. The backend uses a short-lived marker to avoid
   * re-broadcasting the same alert, and the Android client persists it as a
   * unique key in its local Room database.
   */
  dedupeKey: string;
  metadata?: Record<string, unknown> | null;
}

/** In-memory deduplication cache: dedupeKey -> expiry timestamp (ms). */
const dedupeCache = new Map<string, number>();

/** Automatically prune expired keys every 30 minutes. */
setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of dedupeCache.entries()) {
    if (expiresAt <= now) {
      dedupeCache.delete(key);
    }
  }
}, 30 * 60 * 1000).unref();

/**
 * Broadcasts an operational notification over the real-time event stream.
 *
 * Notifications are **never persisted in PostgreSQL**: the device owns them and
 * stores them in its local Room database, where the user can also clear them.
 * That keeps the server stateless for notification history.
 */
export async function createNotification(
  fastify: FastifyInstance,
  input: CreateNotificationInput
): Promise<boolean> {
  try {
    const now = Date.now();
    const existingExpiry = dedupeCache.get(input.dedupeKey);
    if (existingExpiry && existingExpiry > now) {
      return false; // Deduplicated
    }

    // Set deduplication key for 24 hours (86,400,000 ms)
    dedupeCache.set(input.dedupeKey, now + 86_400_000);

    if (typeof fastify.publishDomainEvent === 'function') {
      await fastify.publishDomainEvent({
        type: 'notification',
        organizationId: input.organizationId,
        userIds: [input.userId],
        payload: {
          id: input.dedupeKey,
          type: input.type,
          category: input.type,
          title: input.title,
          body: input.body,
          message: input.body,
          dedupeKey: input.dedupeKey,
          metadata: input.metadata ?? null,
          createdAt: new Date().toISOString(),
        },
      });
    }

    return true;
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to broadcast notification');
    return false;
  }
}

/**
 * Broadcasts the same notification to many recipients.
 */
export async function createNotificationForUsers(
  fastify: FastifyInstance,
  userIds: string[],
  build: (userId: string) => CreateNotificationInput
): Promise<void> {
  for (const userId of userIds) {
    await createNotification(fastify, build(userId));
  }
}
