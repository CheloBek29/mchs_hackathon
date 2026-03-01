/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'mchs-dark': '#1e1e1e',
        'mchs-gray': '#2b2b2b',
        'mchs-green': '#3b8c3b',
        'mchs-green-hover': '#4ca64c',
        'mchs-red': '#e74c3c',
        'mchs-orange': '#f39c12',
        'mchs-blue': '#3498db',
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', 'monospace'],
      },
    },
  },
  plugins: [],
}
