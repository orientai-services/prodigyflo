import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Pin the workspace root so Next does not walk into a parent lockfile.
  turbopack: { root: __dirname },
  serverExternalPackages: ['@prisma/client', 'bcryptjs', '@napi-rs/canvas', 'sharp', 'pdfjs-dist'],
}

export default nextConfig
