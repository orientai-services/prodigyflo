import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Pin the workspace root so Next does not walk into a parent lockfile.
  turbopack: { root: __dirname },
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
}

export default nextConfig
