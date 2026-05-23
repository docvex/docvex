/**
 * Architectural SVG of the DOCVEX brand cabinet.
 *
 * Two smoked-glass doors framed in matte navy aluminum, with a giant
 * wood-veneer "V" spanning the full face — apex at the bottom center.
 * Through the glass, a quiet executive interior: walnut shelves stacked
 * with books, binders, document boxes. Procedural walnut grain via SVG
 * fractal-noise turbulence; brand palette only (navy, beige, cream, wood).
 *
 * Swap for a photoreal render whenever the user generates one:
 * drop /public/cabinet.png and replace this component with <Image src="/cabinet.png" />.
 */
export function LuxuryCabinet({ className = "" }: { className?: string }) {
  return (
    <div className={`relative w-full ${className}`}>
      <svg
        viewBox="0 0 640 860"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto w-full max-w-[520px] mx-auto drop-shadow-[0_30px_60px_rgba(0,0,0,0.55)]"
        role="img"
        aria-label="DOCVEX walnut V cabinet"
      >
        <defs>
          {/* --- WALNUT GRAIN (procedural) --- */}
          <linearGradient id="walnutBase" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#A6724B" />
            <stop offset="55%" stopColor="#8B5E3C" />
            <stop offset="100%" stopColor="#5D3E25" />
          </linearGradient>

          <filter id="grainDark" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.85 0.012"
              numOctaves="5"
              seed="9"
              stitchTiles="stitch"
            />
            <feColorMatrix
              values="0 0 0 0 0.14
                      0 0 0 0 0.07
                      0 0 0 0 0.03
                      0 0 0 0.95 -0.30"
            />
          </filter>

          <filter id="grainLight" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.85 0.012"
              numOctaves="4"
              seed="9"
              stitchTiles="stitch"
            />
            <feColorMatrix
              values="0 0 0 0 1
                      0 0 0 0 0.85
                      0 0 0 0 0.62
                      0 0 0 0.42 -0.45"
            />
          </filter>

          <filter id="knots" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="turbulence"
              baseFrequency="0.020 0.009"
              numOctaves="3"
              seed="3"
              stitchTiles="stitch"
            />
            <feColorMatrix
              values="0 0 0 0 0.05
                      0 0 0 0 0.02
                      0 0 0 0 0.01
                      0 0 0 0.5 -0.5"
            />
          </filter>

          <pattern
            id="walnut"
            patternUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="640"
            height="860"
          >
            <rect width="640" height="860" fill="url(#walnutBase)" />
            <rect width="640" height="860" filter="url(#knots)" />
            <rect width="640" height="860" filter="url(#grainDark)" />
            <rect width="640" height="860" filter="url(#grainLight)" />
          </pattern>

          {/* Lighter walnut for interior shelves (less dark grain) */}
          <pattern
            id="walnutInterior"
            patternUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="640"
            height="200"
          >
            <rect width="640" height="200" fill="#7C5535" />
            <rect width="640" height="200" filter="url(#grainDark)" opacity="0.7" />
            <rect width="640" height="200" filter="url(#grainLight)" opacity="0.6" />
          </pattern>

          {/* --- SMOKED GLASS GRADIENT (front pane) --- */}
          <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0F172A" stopOpacity="0.55" />
            <stop offset="45%" stopColor="#0F172A" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#0F172A" stopOpacity="0.62" />
          </linearGradient>

          {/* Glass reflection highlight */}
          <linearGradient id="glassReflect" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#F5F2EA" stopOpacity="0.18" />
            <stop offset="30%" stopColor="#F5F2EA" stopOpacity="0.03" />
            <stop offset="55%" stopColor="#F5F2EA" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#F5F2EA" stopOpacity="0" />
          </linearGradient>

          {/* --- CABINET INTERIOR BACKWALL --- */}
          <linearGradient id="backwall" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1E293B" />
            <stop offset="100%" stopColor="#0F172A" />
          </linearGradient>

          {/* --- FRAME (matte navy aluminum) --- */}
          <linearGradient id="frame" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#0B1220" />
            <stop offset="50%" stopColor="#1E293B" />
            <stop offset="100%" stopColor="#0B1220" />
          </linearGradient>

          {/* Floor shadow */}
          <radialGradient id="floor" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#000" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>

          {/* Clip the V to the cabinet glass region so it doesn't bleed past the frame */}
          <clipPath id="doorClip">
            <rect x="40" y="40" width="560" height="760" rx="6" />
          </clipPath>
        </defs>

        {/* Floor shadow */}
        <ellipse cx="320" cy="830" rx="280" ry="22" fill="url(#floor)" />

        {/* Cabinet outer frame */}
        <rect
          x="24"
          y="24"
          width="592"
          height="792"
          rx="10"
          fill="url(#frame)"
        />
        {/* Frame highlight */}
        <rect
          x="24"
          y="24"
          width="592"
          height="792"
          rx="10"
          fill="none"
          stroke="#2B3A52"
          strokeWidth="1"
          opacity="0.85"
        />

        {/* Inner door cavity (interior back wall visible through glass) */}
        <rect
          x="40"
          y="40"
          width="560"
          height="760"
          rx="6"
          fill="url(#backwall)"
        />

        {/* === INTERIOR (visible through smoked glass) === */}
        <g clipPath="url(#doorClip)">
          {/* Shelves */}
          {[210, 380, 550, 720].map((y) => (
            <g key={y}>
              <rect
                x="48"
                y={y}
                width="544"
                height="14"
                fill="url(#walnutInterior)"
              />
              <rect
                x="48"
                y={y + 13}
                width="544"
                height="2"
                fill="#000"
                opacity="0.45"
              />
            </g>
          ))}

          {/* Shelf 1 — books */}
          <Books y={150} items={[
            { w: 22, h: 60, fill: "#1E293B" },
            { w: 18, h: 56, fill: "#DCC9A3" },
            { w: 24, h: 58, fill: "#0F172A" },
            { w: 16, h: 52, fill: "#8B5E3C" },
            { w: 28, h: 60, fill: "#1E293B" },
            { w: 20, h: 54, fill: "#E6D6B3" },
            { w: 22, h: 58, fill: "#1E293B" },
            { w: 18, h: 56, fill: "#DCC9A3" },
            { w: 26, h: 60, fill: "#0F172A" },
            { w: 20, h: 54, fill: "#8B5E3C" },
            { w: 22, h: 58, fill: "#1E293B" },
            { w: 18, h: 56, fill: "#DCC9A3" },
            { w: 24, h: 60, fill: "#0F172A" },
          ]} />

          {/* Shelf 2 — binders & legal files */}
          <Books y={320} items={[
            { w: 38, h: 60, fill: "#1E293B" },
            { w: 38, h: 60, fill: "#1E293B" },
            { w: 38, h: 60, fill: "#1E293B" },
            { w: 30, h: 58, fill: "#DCC9A3" },
            { w: 30, h: 58, fill: "#DCC9A3" },
            { w: 30, h: 58, fill: "#DCC9A3" },
            { w: 38, h: 60, fill: "#0F172A" },
            { w: 38, h: 60, fill: "#0F172A" },
            { w: 38, h: 60, fill: "#0F172A" },
          ]} />

          {/* Shelf 3 — leather doc boxes + folder stack */}
          <g>
            {/* Leather box (left) */}
            <rect x="60" y="470" width="160" height="78" rx="3" fill="#5D3E25" />
            <rect x="60" y="470" width="160" height="14" fill="#4A311E" />
            <rect x="130" y="503" width="20" height="6" rx="1" fill="#DCC9A3" />
            <rect x="60" y="470" width="160" height="78" rx="3" fill="none" stroke="#000" strokeOpacity="0.35" />

            {/* Stacked folders (middle) */}
            <g>
              {[0, 9, 18, 27, 36, 45, 54].map((dy, i) => (
                <rect
                  key={i}
                  x={240}
                  y={478 + dy}
                  width={148}
                  height={9}
                  fill={i % 2 === 0 ? "#F5F2EA" : "#E6D6B3"}
                  stroke="#000"
                  strokeOpacity="0.18"
                />
              ))}
            </g>

            {/* Leather box (right) */}
            <rect x="410" y="470" width="180" height="78" rx="3" fill="#3A2718" />
            <rect x="410" y="470" width="180" height="14" fill="#291A0F" />
            <rect x="490" y="503" width="20" height="6" rx="1" fill="#DCC9A3" />
            <rect x="410" y="470" width="180" height="78" rx="3" fill="none" stroke="#000" strokeOpacity="0.35" />
          </g>

          {/* Shelf 4 — architectural tubes + reference books */}
          <g>
            {/* Roll tubes */}
            <rect x="60" y="640" width="14" height="78" rx="7" fill="#DCC9A3" />
            <rect x="78" y="640" width="14" height="78" rx="7" fill="#8B5E3C" />
            <rect x="96" y="640" width="14" height="78" rx="7" fill="#DCC9A3" />
            <rect x="60" y="640" width="50" height="6" rx="2" fill="#000" opacity="0.35" />

            {/* Hardcover books leaning */}
            <Books y={640} x={130} items={[
              { w: 30, h: 78, fill: "#1E293B" },
              { w: 26, h: 76, fill: "#0F172A" },
              { w: 28, h: 78, fill: "#5D3E25" },
              { w: 30, h: 78, fill: "#1E293B" },
              { w: 24, h: 72, fill: "#DCC9A3" },
              { w: 32, h: 78, fill: "#0F172A" },
            ]} />

            {/* Closed binder on the right */}
            <rect x="460" y="660" width="130" height="58" rx="2" fill="#DCC9A3" />
            <rect x="460" y="660" width="130" height="6" fill="#8B5E3C" />
            <line x1="460" y1="690" x2="590" y2="690" stroke="#8B5E3C" strokeWidth="1" opacity="0.6"/>
          </g>
        </g>

        {/* === THE WALNUT V — spans both glass doors, apex bottom-center === */}
        <g clipPath="url(#doorClip)" filter="drop-shadow(0 4px 6px rgba(0,0,0,0.45))">
          <polygon
            points="
              50,52
              168,52
              320,712
              470,52
              590,52
              330,790
              310,790
            "
            fill="url(#walnut)"
          />
          {/* V edge highlights for chiseled depth */}
          <polyline
            points="50,52 320,712 590,52"
            fill="none"
            stroke="#E6D6B3"
            strokeOpacity="0.08"
            strokeWidth="1.5"
          />
        </g>

        {/* === SMOKED GLASS overlay (sits IN FRONT of V to make it feel inset under glass) === */}
        <rect
          x="40"
          y="40"
          width="560"
          height="760"
          rx="6"
          fill="url(#glass)"
        />

        {/* Glass reflection sweep */}
        <rect
          x="40"
          y="40"
          width="560"
          height="760"
          rx="6"
          fill="url(#glassReflect)"
        />

        {/* Vertical highlight slash (window reflection) */}
        <rect
          x="92"
          y="40"
          width="48"
          height="760"
          fill="#F5F2EA"
          opacity="0.05"
        />

        {/* === DOOR SPLIT + HANDLES === */}
        {/* Center seam */}
        <line
          x1="320"
          y1="40"
          x2="320"
          y2="800"
          stroke="#000"
          strokeOpacity="0.55"
          strokeWidth="1"
        />
        <line
          x1="320"
          y1="40"
          x2="320"
          y2="800"
          stroke="#2B3A52"
          strokeOpacity="0.6"
          strokeWidth="0.6"
          transform="translate(0.5,0)"
        />

        {/* Left handle */}
        <rect
          x="305"
          y="370"
          width="4"
          height="120"
          rx="1"
          fill="#0B1220"
        />
        <rect
          x="305"
          y="370"
          width="4"
          height="3"
          fill="#2B3A52"
        />
        {/* Right handle */}
        <rect
          x="331"
          y="370"
          width="4"
          height="120"
          rx="1"
          fill="#0B1220"
        />
        <rect
          x="331"
          y="370"
          width="4"
          height="3"
          fill="#2B3A52"
        />

        {/* Inner frame border (thin) */}
        <rect
          x="40"
          y="40"
          width="560"
          height="760"
          rx="6"
          fill="none"
          stroke="#0B1220"
          strokeWidth="2"
        />

        {/* Subtle top edge highlight on outer frame */}
        <rect
          x="24"
          y="24"
          width="592"
          height="3"
          rx="2"
          fill="#3A4A6A"
          opacity="0.6"
        />
        {/* Bottom plinth */}
        <rect
          x="40"
          y="800"
          width="560"
          height="16"
          fill="#0B1220"
        />
        <rect
          x="40"
          y="800"
          width="560"
          height="1"
          fill="#2B3A52"
        />
      </svg>
    </div>
  );
}

/** A row of book/binder spines on a shelf. */
function Books({
  y,
  x = 60,
  gap = 6,
  items,
}: {
  y: number;
  x?: number;
  gap?: number;
  items: { w: number; h: number; fill: string }[];
}) {
  let cursor = x;
  return (
    <g>
      {items.map((b, i) => {
        const el = (
          <g key={i}>
            <rect
              x={cursor}
              y={y + (78 - b.h)}
              width={b.w}
              height={b.h}
              fill={b.fill}
              stroke="#000"
              strokeOpacity="0.25"
            />
            {/* spine highlight */}
            <rect
              x={cursor}
              y={y + (78 - b.h)}
              width={1}
              height={b.h}
              fill="#F5F2EA"
              opacity="0.10"
            />
            {/* spine band */}
            <rect
              x={cursor}
              y={y + (78 - b.h) + 12}
              width={b.w}
              height={2}
              fill="#000"
              opacity="0.25"
            />
          </g>
        );
        cursor += b.w + gap;
        return el;
      })}
    </g>
  );
}
