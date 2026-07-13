import type {
  VoiceConnection,
  VoiceSessionStatus,
  VoiceToolCall,
  VoiceTranscriptEntry,
} from "@pear-agent/core";

export type VoiceConnectionHandlers = {
  onStatus: (status: VoiceSessionStatus) => void;
  onError: (error: Error) => void;
  onTranscript: (entry: VoiceTranscriptEntry) => void;
  onResumeHandle: (handle: string) => void;
  onToolCall: (calls: VoiceToolCall[]) => void;
};

/**
 * Attach PEAR voice connection event handlers.
 * Returns a single unsubscribe that detaches all listeners.
 */
export function attachVoiceConnectionListeners(
  connection: VoiceConnection,
  handlers: VoiceConnectionHandlers,
): () => void {
  const offs = [
    connection.on("status", handlers.onStatus),
    connection.on("error", handlers.onError),
    connection.on("transcript", handlers.onTranscript),
    connection.on("resumeHandle", handlers.onResumeHandle),
    connection.on("toolCall", handlers.onToolCall),
  ];
  return () => {
    for (const off of offs) {
      off();
    }
  };
}
