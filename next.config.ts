import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // libSQL ships native bindings for the local file driver; keep it external so
  // the bundler never tries to inline it into a serverless function.
  serverExternalPackages: ['@libsql/client', 'libsql'],
  // Episode specs are read from the repository at runtime when GITHUB_REPO is
  // not configured, so they must be traced into the deployment.
  outputFileTracingIncludes: {
    '/**': ['./episodes/**/*.json'],
  },
  experimental: {
    // Generation routes stream work; keep request bodies small and explicit.
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
