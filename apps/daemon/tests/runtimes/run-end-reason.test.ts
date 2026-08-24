import { describe, expect, it } from 'vitest';
import { runEndReason } from '../../src/runtimes/runs.js';

describe('runEndReason', () => {
  it('classifies every terminal path for the web footer', () => {
    expect(runEndReason({ status: 'succeeded' })).toEqual({ code: 'completed' });
    expect(runEndReason({ status: 'succeeded', terminalTrigger: 'inactivity_watchdog' }))
      .toEqual({ code: 'idle_artifact_shutdown' });
    expect(runEndReason({ status: 'succeeded', truncatedMidTurn: true }))
      .toEqual({ code: 'output_truncated' });
    expect(runEndReason({ status: 'canceled', cancelOrigin: 'user_stop' }))
      .toEqual({ code: 'user_canceled' });
    expect(runEndReason({ status: 'canceled', cancelOrigin: 'daemon_shutdown' }))
      .toEqual({ code: 'daemon_shutdown' });
    expect(runEndReason({ status: 'failed', errorCode: 'RATE_LIMITED', error: 'quota' }))
      .toEqual({ code: 'RATE_LIMITED', detail: 'quota' });
  });

  it('uses the persisted terminal reason after daemon restart', () => {
    expect(runEndReason({
      status: 'succeeded',
      endReason: { code: 'output_truncated' },
      truncatedMidTurn: false,
    })).toEqual({ code: 'output_truncated' });
  });
});
