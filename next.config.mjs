/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 'standalone' produces a minimal self-contained server for Azure
  // Container Apps / App Service. Safe to keep for production builds.
  output: 'standalone'
};
export default nextConfig;
