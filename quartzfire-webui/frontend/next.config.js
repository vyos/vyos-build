/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static HTML export — no Node.js runtime on the appliance.
  output: "export",
  // Firewall images are storage-constrained; skip the image optimizer server.
  images: { unoptimized: true },
  // Emit trailing-slash dirs so nginx/ServeDir resolve routes to index.html.
  trailingSlash: true,
};

module.exports = nextConfig;
