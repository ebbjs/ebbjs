import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { renderOgImage } from '../../../lib/og';

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs');
  return docs.map((doc) => ({
    params: { slug: doc.id },
    props: { title: doc.data.title, description: doc.data.description },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const { title, description } = props as { title: string; description: string };

  return renderOgImage({
    title,
    subtitle: description,
    badge: 'docs',
  });
};
