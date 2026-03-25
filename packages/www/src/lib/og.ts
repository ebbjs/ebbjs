import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

// ── Font loading ────────────────────────────────────────────────────────────

export async function loadGoogleFont(
  family: string,
  weight: number,
): Promise<ArrayBuffer> {
  const params = new URLSearchParams({
    family: `${family}:wght@${weight}`,
    display: 'swap',
  });
  const css = await fetch(`https://fonts.googleapis.com/css2?${params}`, {
    headers: {
      // Request TrueType format
      'User-Agent':
        'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1',
    },
  }).then((res) => res.text());

  const match = css.match(/src: url\((.+?)\)/);
  if (!match) throw new Error(`Could not find font URL for ${family}:${weight}`);

  return fetch(match[1]).then((res) => res.arrayBuffer());
}

let fontCache: { inter400: ArrayBuffer; inter700: ArrayBuffer; jetbrainsMono400: ArrayBuffer } | null = null;

export async function loadFonts() {
  if (fontCache) return fontCache;

  const [inter400, inter700, jetbrainsMono400] = await Promise.all([
    loadGoogleFont('Inter', 400),
    loadGoogleFont('Inter', 700),
    loadGoogleFont('JetBrains Mono', 400),
  ]);

  fontCache = { inter400, inter700, jetbrainsMono400 };
  return fontCache;
}

// ── ASCII background generation ─────────────────────────────────────────────

interface Ripple {
  x: number; // 0-1 normalized
  y: number; // 0-1 normalized
  radius: number;
}

const ASCII_CHARS = [' ', '.', '\u00B7', '\u2218', '\u2022', '\u25CF'];

/**
 * Generate a static ASCII art grid simulating the site's ripple background.
 * Returns a string of rows joined by newlines.
 */
export function generateAsciiGrid(
  cols: number,
  rows: number,
  ripples: Ripple[],
): string {
  const waveWidth = 0.06;
  const aspectRatio = 1.8; // chars are taller than wide

  const lines: string[] = [];

  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const nx = x / cols;
      const ny = y / rows;

      let maxIntensity = 0;

      for (const ripple of ripples) {
        const dx = (nx - ripple.x) * aspectRatio;
        const dy = ny - ripple.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const distFromWave = Math.abs(distance - ripple.radius);

        if (distFromWave < waveWidth) {
          const intensity = 1 - distFromWave / waveWidth;
          maxIntensity = Math.max(maxIntensity, intensity);
        }
      }

      const charIndex = Math.floor(maxIntensity * (ASCII_CHARS.length - 1));
      line += ASCII_CHARS[Math.min(charIndex, ASCII_CHARS.length - 1)];
    }
    lines.push(line);
  }

  return lines.join('\n');
}

/** Default ripple positions for the OG cards */
const DEFAULT_RIPPLES: Ripple[] = [
  { x: 0.15, y: 0.3, radius: 0.25 },
  { x: 0.75, y: 0.7, radius: 0.35 },
  { x: 0.5, y: 0.1, radius: 0.5 },
];

// ── Satori element helpers ──────────────────────────────────────────────────

const COLORS = {
  bg: '#0c0a09',
  textPrimary: '#fafaf9',
  textSecondary: '#a8a29e',
  textMuted: '#57534e',
  asciiText: '#292524',
  badgeBg: '#1c1917',
  badgeBorder: '#292524',
  badgeText: '#a8a29e',
} as const;

function ebbLogo() {
  return {
    type: 'svg' as const,
    props: {
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: '0 0 120 58',
      fill: 'none',
      width: 100,
      height: 48,
      children: [
        {
          type: 'path' as const,
          props: {
            d: 'M 24 41 C 34 0, 45 0, 60 29 C 75 58, 86 58, 96 17',
            stroke: COLORS.textPrimary,
            'stroke-width': '9.5',
            'stroke-linecap': 'round',
            fill: 'none',
          },
        },
        {
          type: 'circle' as const,
          props: { cx: '24', cy: '41', r: '13', fill: COLORS.textPrimary },
        },
        {
          type: 'circle' as const,
          props: { cx: '96', cy: '17', r: '13', fill: COLORS.textPrimary },
        },
      ],
    },
  };
}

function asciiBackground(gridText: string) {
  return {
    type: 'div' as const,
    props: {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        overflow: 'hidden',
      },
      children: {
        type: 'pre' as const,
        props: {
          style: {
            fontFamily: 'JetBrains Mono',
            fontSize: '14px',
            lineHeight: '16px',
            color: COLORS.asciiText,
            margin: 0,
            padding: 0,
            whiteSpace: 'pre',
          },
          children: gridText,
        },
      },
    },
  };
}

function badge(text: string) {
  return {
    type: 'div' as const,
    props: {
      style: {
        display: 'flex',
        fontSize: '16px',
        fontWeight: 400,
        color: COLORS.badgeText,
        backgroundColor: COLORS.badgeBg,
        border: `1px solid ${COLORS.badgeBorder}`,
        borderRadius: '6px',
        padding: '4px 12px',
        fontFamily: 'JetBrains Mono',
      },
      children: text,
    },
  };
}

// ── Card builders ───────────────────────────────────────────────────────────

interface OgCardOptions {
  title: string;
  subtitle?: string;
  badge?: string;
}

/**
 * Build the satori virtual-DOM tree for an OG card.
 */
export function buildOgCard({ title, subtitle, badge: badgeText }: OgCardOptions) {
  // Generate ASCII grid sized for 1200x630 at 14px/16px char dimensions
  const gridCols = Math.ceil(1200 / 8.4); // ~143 cols
  const gridRows = Math.ceil(630 / 16); // ~40 rows
  const asciiGrid = generateAsciiGrid(gridCols, gridRows, DEFAULT_RIPPLES);

  const topRow: any[] = [ebbLogo()];
  if (badgeText) {
    topRow.push(badge(badgeText));
  }

  // Scale font size down for longer titles
  const titleFontSize = title.length > 80 ? 36 : title.length > 50 ? 42 : 52;

  const textChildren: any[] = [
    {
      type: 'div',
      props: {
        style: {
          fontSize: `${titleFontSize}px`,
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1.15,
          color: COLORS.textPrimary,
          lineClamp: 3,
          textWrap: 'balance',
        },
        children: title,
      },
    },
  ];

  if (subtitle) {
    textChildren.push({
      type: 'div',
      props: {
        style: {
          fontSize: '24px',
          fontWeight: 400,
          color: COLORS.textSecondary,
          marginTop: '16px',
          lineHeight: 1.4,
          lineClamp: 2,
          textWrap: 'balance',
        },
        children: subtitle,
      },
    });
  }

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
        height: '100%',
        backgroundColor: COLORS.bg,
        color: COLORS.textPrimary,
        fontFamily: 'Inter',
        padding: '60px 80px',
        position: 'relative',
      },
      children: [
        // ASCII background layer
        asciiBackground(asciiGrid),
        // Top bar: logo + optional badge
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              position: 'relative',
            },
            children: topRow,
          },
        },
        // Bottom: title + subtitle + URL
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
            },
            children: [
              ...textChildren,
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '16px',
                    fontWeight: 400,
                    color: COLORS.textMuted,
                    marginTop: '24px',
                    fontFamily: 'JetBrains Mono',
                  },
                  children: 'ebbjs.com',
                },
              },
            ],
          },
        },
      ],
    },
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render an OG card to a PNG Response.
 */
export async function renderOgImage(options: OgCardOptions): Promise<Response> {
  const fonts = await loadFonts();
  const tree = buildOgCard(options);

  const svg = await satori(tree, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Inter', data: fonts.inter400, weight: 400, style: 'normal' as const },
      { name: 'Inter', data: fonts.inter700, weight: 700, style: 'normal' as const },
      { name: 'JetBrains Mono', data: fonts.jetbrainsMono400, weight: 400, style: 'normal' as const },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });
  const png = resvg.render().asPng();

  return new Response(png, {
    headers: { 'Content-Type': 'image/png' },
  });
}
