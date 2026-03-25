import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { renderOgImage } from '../../../lib/og';

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getCollection('devlog');
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { title: post.data.title, description: post.data.description },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const { title, description } = props as { title: string; description: string };

  return renderOgImage({
    title,
    subtitle: description,
    badge: 'devlog',
  });
};
