import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    'http://localhost:3000',
    'http://pris-com.ro',
    'https://pris-com.ro',
    'http://www.pris-com.ro',
    'https://www.pris-com.ro',
    'http://api.pris-com.ro',
    'https://api.pris-com.ro',
    'http://www.api.pris-com.ro',
    'https://www.api.pris-com.ro',
  ],
}

export default nextConfig
