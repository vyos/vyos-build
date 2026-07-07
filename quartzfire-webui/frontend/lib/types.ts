export type RouterStatus = "ok" | "warn" | "crit" | "off";
export type AlarmSeverity = "crit" | "warn" | "info";

export interface Router {
  id: string;
  hostname: string;
  role: string;
  site: string;
  vyosVersion: string;
  lastSeen: string;
  bgpPeers: number | null;
  uptime: string | null;
  status: RouterStatus;
}

export interface Alarm {
  id: string;
  severity: AlarmSeverity;
  title: string;
  routerId: string;
  detail: string;
  when: string;
  acked: boolean;
}

export interface Deployment {
  id: string;
  bundle: string;
  target: string;
  started: string;
  progress: number;
  status: RouterStatus;
}
