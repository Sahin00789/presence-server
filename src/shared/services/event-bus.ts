import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';

export type DomainEventType =
  | 'attendance_update'
  | 'exception_raised'
  | 'payroll_update'
  | 'notification'
  | 'leave_update'
  | 'location_check_updated'
  | 'shift_update'
  | 'premises_update'
  | 'staff_update';

export interface DomainEvent {
  type: DomainEventType;
  organizationId: string;
  /** Restricts delivery to specific user IDs. An empty list or undefined means target all relevant roles/premises. */
  userIds?: string[];
  /** Target premises ID room. */
  premisesId?: string | null;
  /** Specific roles allowed to receive this event (e.g. ['OWNER', 'MANAGER']). Defaults to all if omitted. */
  targetRoles?: ('OWNER' | 'MANAGER' | 'STAFF')[];
  payload: Record<string, unknown>;
  /** Identifies the API instance that published the event, preventing echo delivery. */
  originId?: string;
  emittedAt?: string;
}

export const DOMAIN_EVENT_CHANNEL = 'presence:domain-events';

/**
 * Process-local bus used as the delivery backbone for real-time WebSocket events and cache invalidations.
 */
export const domainEventBus = new EventEmitter();
domainEventBus.setMaxListeners(0);

export interface AttendanceUpdatePayload {
  staffProfileId: string;
  status: string;
  clockIn: string | null;
  clockOut: string | null;
}

export interface ExceptionRaisedPayload {
  exceptionId: string;
  staffProfileId: string;
  staffName: string;
  reason: string;
  consecutiveFailures: number;
}

export interface PayrollUpdatePayload {
  payrollPeriodId: string;
  status: string;
  totalNetSalaryPaise: number;
}

export interface ShiftUpdatePayload {
  shiftTemplateId?: string;
  assignmentId?: string;
  premisesId?: string | null;
  action: 'CREATED' | 'UPDATED' | 'DELETED' | 'ASSIGNED';
}

/**
 * Publishes a domain event to all local subscribers, cache invalidators, and active WebSockets.
 */
export async function publishDomainEvent(
  fastify: FastifyInstance,
  event: DomainEvent
): Promise<void> {
  const envelope = {
    ...event,
    emittedAt: new Date().toISOString(),
  };

  domainEventBus.emit(DOMAIN_EVENT_CHANNEL, envelope);
}
