import { ORB_CUE, ORB_LABEL, type OrbPresence, type OrbPresenceView, type OrbSources } from './state.js';

export function resolvePresence(sources: OrbSources): OrbPresenceView {
  const { diagnostics, captureMuted, now } = sources;

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
    return view('idle', now);
  }

  if (diagnostics.listening) {
    return view('listening', now, { detail: 'Listening for the wake word.' });
  }

  return view('idle', now);
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
