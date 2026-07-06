/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  eslint: {
    // Do not fail production builds on lint issues; lint is run separately.
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
