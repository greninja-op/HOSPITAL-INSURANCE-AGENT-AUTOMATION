/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  eslint: {
    // Do not fail production builds on lint issues; lint is run separately.
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Enables instrumentation.ts `register()`, which runs boot-time config
    // validation (fail-fast) at server startup (Requirement 38).
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
