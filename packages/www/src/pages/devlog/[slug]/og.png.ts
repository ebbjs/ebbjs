import { renderOgCard, staticPathsFor } from "../../../lib/og";

export const getStaticPaths = staticPathsFor("devlog", "devlog");
export const GET = renderOgCard;
