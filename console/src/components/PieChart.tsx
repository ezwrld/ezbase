const COLORS = [
  '#38bdf8', // sky-400
  '#a78bfa', // violet-400
  '#34d399', // emerald-400
  '#fb923c', // orange-400
  '#f472b6', // pink-400
  '#facc15', // yellow-400
  '#22d3ee', // cyan-400
  '#818cf8', // indigo-400
  '#4ade80', // green-400
  '#f87171', // red-400
]

export interface PieSlice {
  label: string
  value: number
  color?: string
}

interface Props {
  slices: PieSlice[]
  size?: number
}

export function PieChart({ slices, size = 180 }: Props) {
  const total = slices.reduce((sum, s) => sum + s.value, 0)

  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="none" stroke="#e4e4e7" strokeWidth="20" />
      </svg>
    )
  }

  const paths: JSX.Element[] = []
  let cumulative = 0

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]!
    const fraction = slice.value / total
    if (fraction === 0) continue

    const color = slice.color ?? COLORS[i % COLORS.length]!
    const startAngle = cumulative * 2 * Math.PI - Math.PI / 2
    cumulative += fraction
    const endAngle = cumulative * 2 * Math.PI - Math.PI / 2

    // Full circle special case
    if (fraction > 0.999) {
      paths.push(
        <circle key={i} cx="50" cy="50" r="40" fill="none" stroke={color} strokeWidth="20" />
      )
      continue
    }

    const x1 = 50 + 40 * Math.cos(startAngle)
    const y1 = 50 + 40 * Math.sin(startAngle)
    const x2 = 50 + 40 * Math.cos(endAngle)
    const y2 = 50 + 40 * Math.sin(endAngle)
    const largeArc = fraction > 0.5 ? 1 : 0

    paths.push(
      <path
        key={i}
        d={`M ${x1} ${y1} A 40 40 0 ${largeArc} 1 ${x2} ${y2}`}
        fill="none"
        stroke={color}
        strokeWidth="20"
      />
    )
  }

  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      {paths}
    </svg>
  )
}

export function getColor(index: number) {
  return COLORS[index % COLORS.length]!
}
