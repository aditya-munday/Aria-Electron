import type { AriaRuntime } from '../runtime.js';
import type { AriaShell } from '../shell/aria-shell.js';
import type { ShellSettings } from '../shell/settings.js';
import type { ErrorReporter } from '../shell/error-reporting.js';
import { redactUserDetail } from '../backend/user-facing.js';
import type { ReportedIncident } from './state.js';
import type { ControlCenterRuntime, VoiceDiagnosticsLike } from './control-center-service.js';

export function createControlCenterRuntime(
  runtime: AriaRuntime,
  shell: AriaShell,
  errors: Pick<ErrorReporter, 'recent'>,
): ControlCenterRuntime {
  return {
    identity: () => runtime.identity(),
    capabilities: async () => {
      const result = await runtime.aria.capabilities();
      if (!result.ok) return result;
      const value = result.value;
      const ttsDetails = value.tts_language_details ?? [];
      const ttsTags = value.tts_languages ?? [];
      const languages = (
        ttsDetails.length > 0
          ? ttsDetails
          : ttsTags.map((tag) => ({ tag, name: tag, native_name: undefined }))
      ).map((language) => ({
        tag: language.tag,
        name: language.name,
        ...(language.native_name !== undefined ? { nativeName: language.native_name } : {}),
      }));
      return {
        ok: true,
        value: {
          voices: value.voices.map((voice) => ({
            id: voice.id,
            name: voice.name,
            language: voice.language,
            ...(voice.accent !== undefined ? { accent: voice.accent.tag } : {}),
            ...(voice.gender !== undefined ? { gender: voice.gender } : {}),
            ...(voice.age !== undefined ? { age: voice.age } : {}),
            ...(voice.styles !== undefined ? { styles: voice.styles } : {}),
            ...(voice.sample_rate !== undefined ? { sampleRate: voice.sample_rate } : {}),
            ...(voice.description !== undefined ? { description: voice.description } : {}),
          })),
          languages,
          sttLanguages: value.stt_languages ?? [],
          ...(value.output_controls !== undefined
            ? {
                outputControls: {
                  pitch: value.output_controls.pitch,
                  volume: value.output_controls.volume,
                  styles: value.output_controls.styles,
                },
              }
            : {}),
        },
      };
    },
    records: () => runtime.supervisor.records(),
    settings: (): ShellSettings => shell.currentSettings(),
    saveSettings: (next: ShellSettings): void => {
      shell.updateSettings(() => next);
    },
    incidents: (): readonly ReportedIncident[] =>
      [...errors.recent()].reverse().map((incident) => ({
        at: incident.at,
        source: incident.source,
        message: redactUserDetail(incident.message),
      })),
    setOrbVisible: (visible: boolean): void => {
      shell.setOrbVisible(visible);
    },
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
            setSpeakResponses: (enabled: boolean): void => {
              runtime.voice?.setSpeakResponses(enabled);
            },
            setSpeechOutput: (output): void => {
              runtime.voice?.setSpeechOutput(output);
            },
            previewSpeech: (input): Promise<void> =>
              runtime.voice?.previewSpeech(input) ?? Promise.resolve(),
          },
  };
}
