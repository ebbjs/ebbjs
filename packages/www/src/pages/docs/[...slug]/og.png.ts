import { renderOgCard, staticPathsFor } from "../../../lib/og";

export const getStaticPaths = staticPathsFor("docs", "docs");
export const GET = renderOgCard;
