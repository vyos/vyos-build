interface SparklineProps {
  data: number[];
  color?: string;
  height?: number;
}

export function Sparkline({
  data,
  color = "var(--qz-accent)",
  height = 36,
}: SparklineProps) {
  const W = 200;
  const H = height;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const rng = max - min || 1;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((v - min) / rng) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const path = `M${points.join(" L")}`;
  const area = `${path} L${W},${H} L0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full block"
      style={{ height: H }}
    >
      <path d={area} fill={color} fillOpacity={0.14} />
      <path d={path} stroke={color} strokeWidth={1.5} fill="none" />
    </svg>
  );
}
