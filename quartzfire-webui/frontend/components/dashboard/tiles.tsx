import { InterfaceStatsTile } from "./InterfaceStatsTile";
import { NetworkSpeedTile } from "./NetworkSpeedTile";
import { RecentIpsAlertsTile } from "./RecentIpsAlertsTile";
import { GeolocationMapTile } from "./GeolocationMapTile";
import { SystemInfoPod } from "./SystemInfoPod";
import { TopApplicationsTile } from "./TopApplicationsTile";
import { TopBlockedCountriesTile } from "./TopBlockedCountriesTile";

/// A type of tile that can be placed on the dashboard. Sizes are in grid units
/// (columns wide × rows tall) on the 4-column dashboard grid.
export interface TileDef {
  type: string;
  title: string;
  defaultW: number;
  defaultH: number;
  minW: number;
  minH: number;
  render: () => React.ReactNode;
}

export const TILE_REGISTRY: Record<string, TileDef> = {
  "system-info": {
    type: "system-info",
    title: "System Information",
    defaultW: 2,
    defaultH: 6,
    minW: 1,
    minH: 4,
    render: () => <SystemInfoPod />,
  },
  "interface-stats": {
    type: "interface-stats",
    title: "Interface Statistics",
    defaultW: 2,
    defaultH: 5,
    minW: 1,
    minH: 3,
    render: () => <InterfaceStatsTile />,
  },
  "network-speed": {
    type: "network-speed",
    title: "Network Speed",
    defaultW: 2,
    defaultH: 5,
    minW: 2,
    minH: 4,
    render: () => <NetworkSpeedTile />,
  },
  "top-applications": {
    type: "top-applications",
    title: "Top Applications",
    defaultW: 2,
    defaultH: 5,
    minW: 1,
    minH: 4,
    render: () => <TopApplicationsTile />,
  },
  "ips-alerts": {
    type: "ips-alerts",
    title: "IPS Alerts",
    defaultW: 2,
    defaultH: 5,
    minW: 1,
    minH: 4,
    render: () => <RecentIpsAlertsTile />,
  },
  "top-blocked-countries": {
    type: "top-blocked-countries",
    title: "Top Blocked Countries",
    defaultW: 2,
    defaultH: 5,
    minW: 1,
    minH: 4,
    render: () => <TopBlockedCountriesTile />,
  },
  "geolocation-map": {
    type: "geolocation-map",
    title: "Geolocation Map",
    defaultW: 1,
    defaultH: 6,
    minW: 1,
    minH: 5,
    render: () => <GeolocationMapTile />,
  },
};

export const TILE_TYPES = Object.values(TILE_REGISTRY);
