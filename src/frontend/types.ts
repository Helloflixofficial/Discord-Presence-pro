export type ActivityType = 0 | 2 | 3 | 5;
export type DisplayType = 0 | 1 | 2;
export type TimestampMode = "last-connection" | "startup" | "local-time" | "presence-update" | "custom";
export type FrameTarget = "large" | "small";

export interface AnimationFrame {
  id: number;
  url: string;
  key: string;
  file_name: string;
  position: number;
  target?: FrameTarget;
  uploaded_at: string;
}

export interface PresenceConfig {
  applicationId: string;
  type: ActivityType;
  display: DisplayType;
  name: string;
  details: string;
  detailsUrl: string;
  state: string;
  stateUrl: string;
  partySize: number;
  partyMax: number;
  timestampMode: TimestampMode;
  customTimestampStart: string;
  customTimestampEndEnabled: boolean;
  customTimestampEnd: string;
  largeKey: string;
  largeText: string;
  largeUrl: string;
  smallKey: string;
  smallText: string;
  smallUrl: string;
  button1Text: string;
  button1Url: string;
  button2Text: string;
  button2Url: string;
}
