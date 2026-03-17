import type { APIRoute } from 'astro';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

async function loadGoogleFont(
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

export const GET: APIRoute = async () => {
  const [interRegular, interBold] = await Promise.all([
    loadGoogleFont('Inter', 400),
    loadGoogleFont('Inter', 700),
  ]);

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          backgroundColor: '#0c0a09',
          color: '#e7e5e4',
          fontFamily: 'Inter',
          padding: '80px',
        },
        children: [
          // Logo (SVG as image)
          {
            type: 'svg',
            props: {
              xmlns: 'http://www.w3.org/2000/svg',
              viewBox: '0 0 120 58',
              fill: 'none',
              width: 120,
              height: 58,
              children: [
                {
                  type: 'path',
                  props: {
                    d: 'M 24 41 C 34 0, 45 0, 60 29 C 75 58, 86 58, 96 17',
                    stroke: '#e7e5e4',
                    'stroke-width': '9.5',
                    'stroke-linecap': 'round',
                    fill: 'none',
                  },
                },
                {
                  type: 'circle',
                  props: {
                    cx: '24',
                    cy: '41',
                    r: '13',
                    fill: '#e7e5e4',
                  },
                },
                {
                  type: 'circle',
                  props: {
                    cx: '96',
                    cy: '17',
                    r: '13',
                    fill: '#e7e5e4',
                  },
                },
              ],
            },
          },
          // Text block
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '72px',
                      fontWeight: 700,
                      letterSpacing: '-0.03em',
                      lineHeight: 1.1,
                      color: '#fafaf9',
                    },
                    children: 'ebb',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '32px',
                      fontWeight: 400,
                      color: '#a8a29e',
                      marginTop: '12px',
                    },
                    children: 'make the network optional.',
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Inter', data: interRegular, weight: 400, style: 'normal' as const },
        { name: 'Inter', data: interBold, weight: 700, style: 'normal' as const },
      ],
    },
  );

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });
  const png = resvg.render().asPng();

  return new Response(png, {
    headers: { 'Content-Type': 'image/png' },
  });
};
