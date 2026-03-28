import type { APIRoute } from "astro";
import { renderOgImage } from "../lib/og";

export const GET: APIRoute = async () => {
  return renderOgImage({
    title: "Build apps that are fast, work offline, and just sync.",
    subtitle: "The real-time backend for your vibe coded frontend.",
  });
};
