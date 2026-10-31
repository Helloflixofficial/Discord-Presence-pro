export type ActivityType = 0 | 2 | 3 | 5;
export type DisplayType = 0 | 1 | 2;
export type TimestampMode =
  | "last-connection"
  | "startup"
  | "presence-update"
  | "elapsed-offset"
  | "countdown"
  | "country-timezone"
  | "local-time"
  | "custom"
  | "none";

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
  selectedTimezone?: string;
  timerOffsetMinutes?: number;
  activityServerHealth?: "none" | "details" | "state";
  line1Mode?: "custom" | "cpu" | "gpu" | "ram" | "none";
  line2Mode?: "custom" | "cpu" | "gpu" | "ram" | "none";
  loadingBarStyle?: string;
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

export interface BridgeStatus {
  connected: boolean;
  applicationId: string | null;
  updatedAt: string | null;
  lastError: string | null;
}

export const defaultPresence = (applicationId: string): PresenceConfig => ({
  applicationId,
  type: 0,
  display: 0,
  name: "",
  details: "",
  detailsUrl: "",
  state: "",
  stateUrl: "",
  partySize: 0,
  partyMax: 0,
  timestampMode: "last-connection",
  customTimestampStart: new Date().toISOString().slice(0, 16),
  customTimestampEndEnabled: false,
  customTimestampEnd: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16),
  selectedTimezone: "UTC",
  timerOffsetMinutes: 0,
  activityServerHealth: "none",
  line1Mode: "cpu",
  line2Mode: "ram",
  loadingBarStyle: "capsule",
  largeKey: "",
  largeText: "",
  largeUrl: "",
  smallKey: "",
  smallText: "",
  smallUrl: "",
  button1Text: "",
  button1Url: "",
  button2Text: "",
  button2Url: ""
});
