import type { VoiceConnection, VoiceToolCall, VoiceTranscriptEntry } from "@pear-agent/core";

export type ExecuteVoiceToolInput = {
  toolName: string;
  args?: Record<string, unknown>;
  callId?: string;
  confidence?: number;
};

export type ExecuteVoiceToolResult =
  | { callId: string | null; toolName: string; ok: true; result: unknown }
  | {
      callId: string | null;
      toolName: string;
      ok: false;
      error: true;
      message: string;
    };

export type HandleVoiceToolCallsDeps = {
  sessionId: string;
  connection: VoiceConnection;
  calls: VoiceToolCall[];
  /** Generation guard — skip work / send when superseded. */
  isCurrent: () => boolean;
  appendTranscript: (entry: VoiceTranscriptEntry) => void;
  executeVoiceTool: (
    sessionId: string,
    input: ExecuteVoiceToolInput,
  ) => Promise<ExecuteVoiceToolResult>;
};

/**
 * Bridge provider tool calls to `POST /sessions/:id/voice/tools`, then
 * send responses back on the Voice connection.
 *
 * Pure-ish async helper: no React state; callers supply epoch/transcript deps.
 */
export async function handleVoiceToolCalls(deps: HandleVoiceToolCallsDeps): Promise<void> {
  const { sessionId, connection, calls, isCurrent, appendTranscript, executeVoiceTool } = deps;
  if (!isCurrent()) return;

  const responses: Array<{
    id: string;
    name: string;
    response: { result: unknown } | { error: true; message: string };
  }> = [];

  for (const call of calls) {
    appendTranscript({ role: "tool", text: `tool: ${call.name}` });
    try {
      const result = await executeVoiceTool(sessionId, {
        toolName: call.name,
        args: call.args,
        callId: call.id,
        ...(typeof call.args.confidence === "number" ? { confidence: call.args.confidence } : {}),
      });
      if (result.ok) {
        responses.push({
          id: call.id,
          name: call.name,
          response: { result: result.result ?? null },
        });
      } else {
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            error: true,
            message: result.message ?? `Tool failed: ${call.name}`,
          },
        });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      responses.push({
        id: call.id,
        name: call.name,
        response: { error: true, message },
      });
    }
  }

  if (!isCurrent()) return;
  connection.sendToolResponse(responses);
}
