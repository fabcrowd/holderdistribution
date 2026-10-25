import { useEffect } from 'react';

export interface JsonLdSchema {
  '@context': string;
  '@type': string;
  [key: string]: unknown;
}

interface PageMetaProps {
  title: string;
  description: string;
  canonicalPath: string;
  ogImage?: string;
  ogType?: string;
  jsonLd?: JsonLdSchema[];
}

const SITE_URL = (import.meta.env.VITE_SITE_URL ?? 'https://holderdistribution.com').replace(/\/$/, '');

export const usePageMeta = ({ 
  title, 
  description, 
  canonicalPath,
  ogImage = '/og-image.png?v=20261025',
  ogType,
  jsonLd,
}: PageMetaProps) => {
  useEffect(() => {
    // Update title
    document.title = title;

    // Update meta description
    const metaDescription = document.querySelector('meta[name="description"]');
    if (metaDescription) {
      metaDescription.setAttribute('content', description);
    }

    // Update OG description
    const ogDescription = document.querySelector('meta[property="og:description"]');
    if (ogDescription) {
      ogDescription.setAttribute('content', description);
    }

    // Update Twitter description
    const twitterDescription = document.querySelector('meta[name="twitter:description"]');
    if (twitterDescription) {
      twitterDescription.setAttribute('content', description);
    }

    // Update OG title
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      ogTitle.setAttribute('content', title);
    }

    // Update Twitter title
    const twitterTitle = document.querySelector('meta[name="twitter:title"]');
    if (twitterTitle) {
      twitterTitle.setAttribute('content', title);
    }

    // Update canonical URL
    const baseUrl = SITE_URL;
    const fullUrl = `${baseUrl}${canonicalPath}`;
    
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', fullUrl);

    // Update OG URL
    let ogUrl = document.querySelector('meta[property="og:url"]');
    if (!ogUrl) {
      ogUrl = document.createElement('meta');
      ogUrl.setAttribute('property', 'og:url');
      document.head.appendChild(ogUrl);
    }
    ogUrl.setAttribute('content', fullUrl);

    // Update OG Image
    const imageUrl = ogImage?.startsWith('http') ? ogImage : `${baseUrl}${ogImage}`;
    const ogImageMeta = document.querySelector('meta[property="og:image"]');
    if (ogImageMeta) {
      ogImageMeta.setAttribute('content', imageUrl);
    }

    // Update Twitter Image
    const twitterImageMeta = document.querySelector('meta[name="twitter:image"]');
    if (twitterImageMeta) {
      twitterImageMeta.setAttribute('content', imageUrl);
    }

    // Update OG type (defaults to 'website' from index.html)
    let ogTypeMeta = document.querySelector('meta[property="og:type"]');
    if (!ogTypeMeta) {
      ogTypeMeta = document.createElement('meta');
      ogTypeMeta.setAttribute('property', 'og:type');
      document.head.appendChild(ogTypeMeta);
    }
    ogTypeMeta.setAttribute('content', ogType || 'website');

    // Inject JSON-LD schemas
    const existingScripts = document.querySelectorAll('script[data-page-schema]');
    existingScripts.forEach((el) => el.remove());

    if (jsonLd && jsonLd.length > 0) {
      jsonLd.forEach((schema) => {
        const script = document.createElement('script');
        script.setAttribute('type', 'application/ld+json');
        script.setAttribute('data-page-schema', 'true');
        script.textContent = JSON.stringify(schema);
        document.head.appendChild(script);
      });
    }

    return () => {
      const scripts = document.querySelectorAll('script[data-page-schema]');
      scripts.forEach((el) => el.remove());
    };
  }, [title, description, canonicalPath, ogImage, ogType, jsonLd]);
};
