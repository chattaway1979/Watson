/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 'standalone' produces a minimal self-contained server for Azure
  // Container Apps / App Service. Safe to keep for production builds.
  output: 'standalone',
  // 021C-2: file tracing copied the developer's LOCAL runtime store
  // (data/watson-store.json) into the standalone output, so the deployment
  // artifact carried synthetic RBAC assignments. Exclude the runtime store
  // directory from tracing; `npm run build` additionally fails hard via
  // scripts/check-no-bundled-store.mjs if anything like it reappears.
  outputFileTracingExcludes: {
    '*': ['./data/**']
  }
};
export default nextConfig;
