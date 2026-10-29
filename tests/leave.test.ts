import { describe, expect, it } from 'vitest';
import {
  createLeaveRequestSchema,
  leaveRequestsQuerySchema,
  reviewLeaveRequestSchema,
} from '../src/modules/leave/schemas.js';
import { mapLeave } from '../src/modules/leave/service.js';

describe('Single-Shift Leave Request Module', () => {
  describe('Leave schemas validation', () => {
    it('accepts valid single-shift leave request creation input', () => {
      const valid = {
        shiftAssignmentId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        workDate: '2025-06-15',
        reason: 'Medical checkup appointment',
      };
      const parsed = createLeaveRequestSchema.parse(valid);
      expect(parsed.shiftAssignmentId).toBe(valid.shiftAssignmentId);
      expect(parsed.workDate).toBe('2025-06-15');
      expect(parsed.reason).toBe('Medical checkup appointment');
    });

    it('rejects invalid workDate format', () => {
      const invalid = {
        shiftAssignmentId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        workDate: '15-06-2025',
        reason: 'Family event',
      };
      expect(() => createLeaveRequestSchema.parse(invalid)).toThrow();
    });

    it('accepts review input with decision and reviewRemarks or note', () => {
      const approve = reviewLeaveRequestSchema.parse({
        decision: 'APPROVED',
        reviewRemarks: 'Approved by manager',
      });
      expect(approve.decision).toBe('APPROVED');
      expect(approve.reviewRemarks).toBe('Approved by manager');

      const reject = reviewLeaveRequestSchema.parse({
        decision: 'REJECTED',
        note: 'Insufficient notice provided',
      });
      expect(reject.decision).toBe('REJECTED');
      expect(reject.note).toBe('Insufficient notice provided');
    });

    it('validates leave query filters', () => {
      const query = leaveRequestsQuerySchema.parse({
        status: 'PENDING',
        premisesId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        from: '2025-06-01',
        to: '2025-06-30',
      });
      expect(query.status).toBe('PENDING');
      expect(query.premisesId).toBe('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22');
    });
  });

  describe('mapLeave mapping helper', () => {
    it('formats single-shift leave request record correctly', () => {
      const now = new Date('2025-06-10T10:00:00Z');
      const mockRow = {
        leave: {
          id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
          organisationId: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
          organizationId: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
          premisesId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55',
          staffId: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
          employeeId: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
          shiftAssignmentId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          workDate: '2025-06-15',
          reason: 'Personal leave',
          status: 'APPROVED' as const,
          reviewedBy: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a77',
          reviewedAt: now,
          reviewRemarks: 'Approved by Manager',
          createdAt: now,
          updatedAt: now,
        },
        staffName: 'John Doe',
        staffCode: 'EMP-001',
        premisesName: 'Headquarters',
        shiftName: 'Day Shift',
        startTime: '09:00:00',
        endTime: '17:00:00',
        reviewedByName: 'Jane Manager',
      };

      const result = mapLeave(mockRow);
      expect(result.id).toBe(mockRow.leave.id);
      expect(result.organisationId).toBe(mockRow.leave.organisationId);
      expect(result.premisesId).toBe(mockRow.leave.premisesId);
      expect(result.premisesName).toBe('Headquarters');
      expect(result.staffId).toBe(mockRow.leave.staffId);
      expect(result.staffName).toBe('John Doe');
      expect(result.staffCode).toBe('EMP-001');
      expect(result.shiftAssignmentId).toBe(mockRow.leave.shiftAssignmentId);
      expect(result.shiftName).toBe('Day Shift');
      expect(result.shiftHours).toBe('09:00 - 17:00');
      expect(result.workDate).toBe('2025-06-15');
      expect(result.status).toBe('APPROVED');
      expect(result.reviewedByName).toBe('Jane Manager');
      expect(result.reviewRemarks).toBe('Approved by Manager');
    });
  });
});
