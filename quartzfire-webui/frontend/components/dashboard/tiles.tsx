import { InterfaceStatsTile } from "./InterfaceStatsTile";
import { NetworkSpeedTile } from "./NetworkSpeedTile";
import { SystemInfoPod } from "./SystemInfoPod";

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
};

export const TILE_TYPES = Object.values(TILE_REGISTRY);
