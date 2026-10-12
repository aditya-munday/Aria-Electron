import {
  ORB_CUE,
  ORB_LABEL,
  type OrbPresence,
  type OrbPresenceView,
  type OrbSources,
  type OrbTaskView,
} from './state.js';

export function resolvePresence(sources: OrbSources): OrbPresenceView {
  const { diagnostics, captureMuted, task, now } = sources;

  if (captureMuted) {
    return view('muted', now, {
      detail: 'Capture is muted; voice activation is paused until it is unmuted.',
    });
  }

  if (diagnostics === undefined) {
    return view('idle', now, {
      detail: 'Voice is unavailable on this build; typed chat still works.',
    });
  }

  if (diagnostics.lastError !== undefined) {
    return view('error', now, {
      detail: diagnostics.lastError.message,
    });
  }

  const state = diagnostics.sessionState;
  if (state === 'capturing' || state === 'transcribing') {
    return view('listening', now);
  }
  if (state === 'thinking') {
    return view('thinking', now);
  }
  if (state === 'speaking') {
    return view('speaking', now);
  }
  if (state === 'failed') {
    return view('error', now);
  }
  if (state === 'cancelled') {
    return view('interrupted', now, {
      detail: 'The turn was stopped before it finished.',
    });
  }

  const taskView = taskPresence(task, now);
  if (taskView !== undefined) return taskView;

  if (diagnostics.listening) {
    return view('listening', now, { detail: 'Listening for the wake word.' });
  }

  return view('idle', now);
}

function taskPresence(task: OrbTaskView | undefined, now: string): OrbPresenceView | undefined {
  if (task === undefined) return undefined;

  if (task.pendingPlans > 0 || task.pendingPermissions > 0) {
    return view('awaiting_approval', now, {
      detail: 'A plan is waiting for your approval.',
    });
  }

  if (task.pendingQuestions > 0) {
    return view('awaiting_input', now, {
      detail: 'A task is waiting for your answer.',
    });
  }

  if (task.phase === 'unknown') {
    return view('recovering', now, {
      detail: 'An outcome is unknown; reconciling against the Backend.',
    });
  }

  if (task.phase === 'failed') {
    return view('error', now, { detail: 'The last task failed.' });
  }

  if (
    task.phase === 'accepted' ||
    task.phase === 'running' ||
    task.phase === 'cancellation_unconfirmed'
  ) {
    return view('task_running', now, {
      detail:
        task.phase === 'cancellation_unconfirmed'
          ? 'Cancellation requested; waiting for the worker to confirm.'
          : 'A task is running in the background.',
    });
  }

  return undefined;
}

function view(
  presence: OrbPresence,
  updatedAt: string,
  extra: { readonly detail?: string } = {},
): OrbPresenceView {
  return {
    presence,
    cue: ORB_CUE[presence],
    label: ORB_LABEL[presence],
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    updatedAt,
  };
}
