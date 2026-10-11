import { describe, expect, it } from 'vitest';

import { InteractionController, type InteractionRuntime } from './interaction-controller.js';
import type { InteractionEnvironment } from './interaction-router.js';
import { isRoutedControl, routeActivation, type RoutedControl } from './interaction-router.js';

class RecordingRuntime implements InteractionRuntime {
  readonly calls: string[] = [];
  pushToTalkPress(): void {
    this.calls.push('press');
  }
  pushToTalkRelease(): void {
    this.calls.push('release');
  }
  sendText(text: string): void {
    this.calls.push(`sendText:${text}`);
  }
  interrupt(): void {
    this.calls.push('interrupt');
  }
}

const READY: InteractionEnvironment = {
  wakeWordEnabled: true,
  microphonePermission: 'granted',
  voiceSessionActive: false,
};

/** A control seam that records requests and can fail the network request. */
class RecordingControl {
  readonly cancellations: (string | undefined)[] = [];
  engaged = 0;
  constructor(private readonly failRequest = false) {}
  requestCancellation(taskId?: string): boolean {
    this.cancellations.push(taskId);
    if (this.failRequest) throw new Error('orchestration connection is down');
    return true;
  }
  engageEmergencyStop(): void {
    this.engaged += 1;
  }
}

function controlOf(result: Awaited<ReturnType<InteractionController['handle']>>): RoutedControl {
  if (result.kind !== 'routed' || !isRoutedControl(result.routed)) {
    throw new Error('expected a routed control');
  }
  return result.routed;
}

describe('interaction controller: local control paths', () => {
  it('keeps stopping playback distinct from cancelling a task', async () => {
    const runtime = new RecordingRuntime();
    const control = new RecordingControl();
    const controller = new InteractionController({ environment: READY, runtime, control });

    const stop = controlOf(await controller.handle({ kind: 'stop_playback' }));
    expect(stop.kind).toBe('playback_stop');
    // Playback stop interrupts local audio; it never requests a cancellation.
    expect(runtime.calls).toEqual(['interrupt']);
    expect(control.cancellations).toEqual([]);

    const cancel = controlOf(await controller.handle({ kind: 'cancel_task', taskId: 't9' }));
    expect(cancel.kind).toBe('task_cancellation_requested');
    // A task cancellation is a request, not a playback stop.
    expect(control.cancellations).toEqual(['t9']);
    expect(runtime.calls).toEqual(['interrupt']);
  });

  it('represents a task cancellation as a request, never a confirmed stop', async () => {
    const control = new RecordingControl();
    const controller = new InteractionController({
      environment: READY,
      runtime: new RecordingRuntime(),
      control,
    });
    const cancel = controlOf(await controller.handle({ kind: 'cancel_task', taskId: 't9' }));
    // The output names the request; it carries no "stopped" claim.
    expect(cancel.kind).toBe('task_cancellation_requested');
    expect(JSON.stringify(cancel)).not.toContain('confirmed');
    expect(JSON.stringify(cancel)).not.toContain('stopped');
  });

  it('engages the emergency stop locally and requests cancellation of all work', async () => {
    const runtime = new RecordingRuntime();
    const control = new RecordingControl();
    const controller = new InteractionController({ environment: READY, runtime, control });

    const emergency = controlOf(await controller.handle({ kind: 'emergency_stop' }));

    // The local engage happens and the request targets all active work.
    expect(control.engaged).toBe(1);
    expect(control.cancellations).toEqual([undefined]);
    // It is a distinct output: neither a playback stop nor a single-task cancel.
    expect(emergency.kind).toBe('emergency_stop');
    if (emergency.kind === 'emergency_stop') {
      expect(emergency.engage.engaged).toBe(true);
      expect(emergency.requestCancellation.request).toBe('all_active');
    }
    expect(runtime.calls).toEqual([]);
  });

  it('does not let a failed orchestration request undo the local emergency stop', async () => {
    const control = new RecordingControl(true);
    const controller = new InteractionController({
      environment: READY,
      runtime: new RecordingRuntime(),
      control,
    });
    const result = await controller.handle({ kind: 'emergency_stop' });
    expect(result.kind).toBe('routed');
    // The engage is local and already done; the failed request does not revert it.
    expect(control.engaged).toBe(1);
    expect(control.cancellations).toEqual([undefined]);
  });

  it('routes the emergency stop without any model inference or orchestration dependency', () => {
    // The pure router reaches the emergency-stop routing with no environment
    // and no runtime: there is nothing to reach for, by construction.
    const result = routeActivation({ kind: 'emergency_stop' });
    expect(result.kind).toBe('routed');
    if (result.kind !== 'routed') return;
    expect(isRoutedControl(result.routed)).toBe(true);
    expect(result.routed).toMatchObject({ kind: 'emergency_stop' });
  });
});
