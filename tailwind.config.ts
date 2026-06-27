import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        watson: {
          ink: '#0f172a',
          slate: '#1e293b',
          steel: '#334155',
          mist: '#64748b',
          line: '#e2e8f0',
          bg: '#f8fafc',
          accent: '#1d4ed8',
          accentSoft: '#dbeafe',
          gold: '#b45309'
        }
      }
    }
  },
  plugins: []
};
export default config;
