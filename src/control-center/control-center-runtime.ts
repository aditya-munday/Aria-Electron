import type { AriaRuntime } from '../runtime.js';
import type { AriaShell } from '../shell/aria-shell.js';
import type { ShellSettings } from '../shell/settings.js';
import type { ErrorReporter } from '../shell/error-reporting.js';
import type { ReportedIncident } from './state.js';
import type { ControlCenterRuntime, VoiceDiagnosticsLike } from './control-center-service.js';

export function createControlCenterRuntime(
  runtime: AriaRuntime,
  shell: AriaShell,
  errors: Pick<ErrorReporter, 'recent'>,
): ControlCenterRuntime {
  return {
    identity: () => runtime.identity(),
    capabilities: () => runtime.aria.capabilities(),
    records: () => runtime.supervisor.records(),
    settings: (): ShellSettings => shell.currentSettings(),
    saveSettings: (next: ShellSettings): void => {
      shell.updateSettings(() => next);
    },
    incidents: (): readonly ReportedIncident[] => errors.recent(),
    voiceDiagnostics: (): VoiceDiagnosticsLike | undefined => {
      const voice = runtime.voice;
      if (voice === undefined) return undefined;
      const diagnostics = voice.diagnostics();
      return {
        wakeWordEnabled: diagnostics.wakeWordEnabled,
        wakeWordStatus: diagnostics.wakeWordStatus,
        ...(diagnostics.wakeWordModel !== undefined
          ? { wakeWordModel: diagnostics.wakeWordModel }
          : {}),
        ...(diagnostics.wakeWordFailure !== undefined
          ? { wakeWordFailure: diagnostics.wakeWordFailure }
          : {}),
        listening: diagnostics.listening,
        ...(diagnostics.lastError !== undefined ? { lastError: diagnostics.lastError } : {}),
      };
    },
    voice:
      runtime.voice === undefined
        ? undefined
        : {
            setWakeWordEnabled: (enabled: boolean): Promise<void> =>
              runtime.voice?.setWakeWordEnabled(enabled) ?? Promise.resolve(),
            setPushToTalkMode: (mode: 'hold' | 'toggle'): void => {
              runtime.voice?.setPushToTalkMode(mode);
            },
          },
  };
}
