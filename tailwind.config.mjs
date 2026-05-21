/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    borderRadius: {
      'none': '0px',
      'sm': '0px',
      DEFAULT: '0px',
      'md': '0px',
      'lg': '0px',
      'xl': '0px',
      '2xl': '0px',
      '3xl': '0px',
      'full': '9999px',
    },
    extend: {
      colors: {
        dark: {
          bg: '#0f0f0f',
          card: '#1a1a1a',
          border: '#2a2a2a',
          hover: '#252525',
        },
        brand: {
          primary: '#6366f1',
          hover: '#818cf8',
        },
      },
    },
  },
  plugins: [],
};
