import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // pdf-parse loads the PDF.js worker by filesystem path at runtime. Next's
  // standalone tracer sees pdf.mjs but cannot infer that sibling worker file.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdf-parse/dist/pdf-parse/esm/pdf.worker.mjs"
    ]
  },
  // officeparser offers its own optional OCR path and therefore declares
  // tesseract.js. Fanmili routes OCR through the separate component instead,
  // so these large WASM assets must not be copied into the default image.
  outputFileTracingExcludes: {
    "/*": [
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*"
    ]
  },
  devIndicators: false,
  reactStrictMode: true,
  // pdf-parse locates its worker script at runtime. Keeping it external prevents
  // Next's server bundler from rewriting that path.
  serverExternalPackages: [
    "pdf-parse"
  ],
};

export default nextConfig;
