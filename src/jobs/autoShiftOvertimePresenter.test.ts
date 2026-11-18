import { describe, expect, it, vi } from 'vitest';
import { processAutoPresentAndOvertimeCompletion } from './autoShiftOvertimePresenter.js';

describe('Auto Shift & Overtime Presenter Job', () => {
  it('handles empty database gracefully without throwing', async () => {
    const fakeFastify: any = {
      db: {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            innerJoin: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockResolvedValue([]),
            })),
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      },
      log: {
        error: vi.fn(),
      },
    };

    const result = await processAutoPresentAndOvertimeCompletion(fakeFastify);
    expect(result).toEqual({ shiftsProcessed: 0, overtimesProcessed: 0 });
  });
});
