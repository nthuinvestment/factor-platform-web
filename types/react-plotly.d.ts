declare module "react-plotly.js" {
  import * as React from "react";

  type PlotlyFigure = Record<string, any>;
  type PlotlyLayout = Record<string, any>;
  type PlotlyConfig = Record<string, any>;

  export interface PlotParams extends React.PropsWithChildren {
    data?: PlotlyFigure[];
    layout?: PlotlyLayout;
    config?: PlotlyConfig;
    frames?: any[];
    style?: React.CSSProperties;
    className?: string;
    useResizeHandler?: boolean;
    onInitialized?: (...args: any[]) => void;
    onUpdate?: (...args: any[]) => void;
    onPurge?: (...args: any[]) => void;
    onError?: (...args: any[]) => void;
    divId?: string;
    revision?: number;
    debug?: boolean;
  }

  const Plot: React.ComponentType<PlotParams>;
  export default Plot;
}
