export type ShareAccess = "view" | "steer" | "approve";

export type RemoteHostMsgPayload =
  | {
      type: "welcome";
      proto: number;
      tabTitle: string;
      cols: number;
      rows: number;
      tabType?: "terminal" | "app" | "contribution";
      attachmentId?: string;
      attachmentGeneration?: number;
    }
  | { type: "snapshot"; b64: string; cols: number; rows: number }
  | { type: "output"; b64: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "presence"; viewers: number }
  | { type: "end"; reason: string }
  | { type: "pong" };
