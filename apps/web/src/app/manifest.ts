import type { MetadataRoute } from "next";
import { appScope, withAppBasePath } from "@/lib/appBasePath";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fanmili",
    short_name: "Fanmili",
    description: "家庭生活记录与 AI 协作空间",
    start_url: appScope(),
    id: appScope(),
    scope: appScope(),
    display: "standalone",
    background_color: "#202321",
    theme_color: "#2f6f68",
    icons: [
      {
        src: withAppBasePath("/family-logo-v2-192.png"),
        sizes: "192x192",
        type: "image/png",
        purpose: "any"
      },
      {
        src: withAppBasePath("/family-logo-v2-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
      },
      {
        src: withAppBasePath("/family-logo-v2-maskable-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  };
}
