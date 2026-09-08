import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // C:\Users\RZER has its own package-lock.json; without this Next walks up and
  // picks the wrong workspace root.
  turbopack: { root: __dirname },
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
}

export default nextConfig
