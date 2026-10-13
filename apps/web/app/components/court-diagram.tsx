import { useId } from "react";
import type { CourtSpot } from "@/lib/drills";

export default function CourtDiagram({ spots, route, activeSpot, compact = false, title = "Shooting spots" }: {
  spots: readonly CourtSpot[];
  route?: readonly number[];
  activeSpot?: number;
  compact?: boolean;
  title?: string;
}) {
  const markerId = useId().replace(/:/g, "");
  const point = (spot: CourtSpot) => ({ x: 14 + spot.x * 292, y: 14 + spot.y * 280 });
  const path = (route ?? []).map((index) => spots[index]).filter(Boolean).map(point);
  return (
    <svg viewBox="0 0 320 320" role="img" aria-label={`${title}, schematic spots, not to scale`}
      className="h-auto w-full font-sans" fill="none">
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent, #d94f19)" />
        </marker>
      </defs>
      <rect width="320" height="320" rx="18" fill="var(--surface, #fff)" />
      <rect x="14" y="14" width="292" height="280" rx="14" fill="var(--accent-soft, #fff0e5)" />
      <g stroke="var(--muted, #64655f)" strokeWidth="1.6">
        <rect x="14" y="14" width="292" height="280" rx="14" />
        <path d="M108 14 V140 H212 V14 M108 140 C108 210 212 210 212 140" />
        <path d="M38 14 V76 C38 246 282 246 282 76 V14" />
        <path d="M130 294 A30 30 0 0 1 190 294" />
      </g>
      <path d="M144 34 H176" stroke="var(--foreground, #232722)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="160" cy="44" r="6" stroke="var(--accent, #d94f19)" strokeWidth="2.5" />
      {path.length > 1 ? <g stroke="var(--accent, #d94f19)" strokeWidth="1.5" strokeDasharray="4 5" opacity="0.65">
        {path.slice(1).map((end, index) => <path key={index} d={`M${path[index].x} ${path[index].y} L${end.x} ${end.y}`} markerEnd={`url(#${markerId})`} />)}
      </g> : null}
      {spots.map((spot, index) => {
        const { x, y } = point(spot);
        const active = activeSpot === undefined || activeSpot === index;
        return <g key={`${spot.x}-${spot.y}-${index}`}>
          <circle cx={x} cy={y} r={compact ? 8 : 11} fill={active ? "var(--accent, #d94f19)" : "var(--surface, #fff)"}
            stroke="var(--accent, #d94f19)" strokeWidth="2" />
          {!compact ? <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="central" fill={active ? "var(--background, #f7f7f2)" : "var(--accent, #d94f19)"} fontSize="10" fontWeight="700">{index + 1}</text> : null}
          {!compact && spot.label ? <text x={x} y={y + 27} textAnchor="middle" fill="var(--foreground, #232722)" fontSize="11">{spot.label}</text> : null}
        </g>;
      })}
      <text x="160" y="312" textAnchor="middle" fill="var(--muted, #64655f)" fontSize="10">Schematic spots · Not to scale</text>
    </svg>
  );
}
