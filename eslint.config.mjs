// Next 16 removed the built-in `next lint` command. ESLint runs directly via
// `eslint .` with flat config. eslint-config-next 16 ships a native flat-config
// array, so it is imported and spread directly (no FlatCompat bridge needed).
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...nextCoreWebVitals,
  {
    rules: {
      '@next/next/no-img-element': 'off',
      // New in eslint-config-next 16 (react-hooks v7). Our client components
      // intentionally initialize CLIENT-ONLY state (e.g. reading document.cookie
      // for the demo role) inside an effect after mount. Moving these to a
      // useState initializer would run during SSR (document undefined) and cause
      // hydration mismatches, so the effect pattern is the correct, hydration-safe
      // choice here. Kept as a non-blocking warning for visibility.
      'react-hooks/set-state-in-effect': 'warn'
    }
  }
];

export default eslintConfig;
