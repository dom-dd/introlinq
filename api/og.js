import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

export default function handler() {
  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          background: '#1a1a2e',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px',
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'baseline',
                marginBottom: '28px',
              },
              children: [
                {
                  type: 'span',
                  props: {
                    style: {
                      fontFamily: 'Georgia, serif',
                      fontSize: '96px',
                      fontWeight: '700',
                      color: '#ffffff',
                      letterSpacing: '-3px',
                    },
                    children: 'Intro',
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: {
                      fontFamily: 'Georgia, serif',
                      fontSize: '96px',
                      fontWeight: '700',
                      color: '#3d7a5f',
                      letterSpacing: '-3px',
                    },
                    children: 'Linq',
                  },
                },
              ],
            },
          },
          {
            type: 'div',
            props: {
              style: {
                fontSize: '38px',
                color: 'rgba(255,255,255,0.6)',
                textAlign: 'center',
                fontFamily: 'Georgia, serif',
                maxWidth: '800px',
                lineHeight: '1.4',
              },
              children: "Earn from every expert you'd recommend",
            },
          },
          {
            type: 'div',
            props: {
              style: {
                marginTop: '48px',
                background: '#3d7a5f',
                color: '#ffffff',
                fontSize: '28px',
                fontWeight: '600',
                padding: '16px 40px',
                borderRadius: '100px',
                fontFamily: 'Georgia, serif',
              },
              children: '50% commission · Free forever',
            },
          },
        ],
      },
    },
    { width: 1200, height: 630 }
  );
}
