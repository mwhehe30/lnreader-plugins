import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { CheerioAPI, load as parseHTML } from 'cheerio';

const SITE = 'https://azzusanovel.wordpress.com';

const NOVELS: Plugin.NovelItem[] = [
  {
    name: 'Omniscient Reader’s Viewpoint',
    path: '/webnovel/omniscient-readers-viewpoint-bahasa-indonesia/',
    cover: `${SITE}/wp-content/uploads/2020/07/orv_volume_4_cover_korean_ver.jpg`,
  },
  {
    name: 'Trash of The Count’s Family',
    path: '/webnovel/trash-of-the-counts-family-bahasa-indonesia/',
    cover: `${SITE}/wp-content/uploads/2020/07/large.jpeg`,
  },
  {
    name: 'The S-Classes That I Raised',
    path: '/webnovel/s-classes-that-i-raised-bahasa-indonesia/',
    cover: 'https://cdn.novelupdates.com/images/2019/05/xxlarge.png',
  },
];

const CHAPTER_RE = /\/(?:ch\d+|(?:orv|tcf|sclass)-\d+(?:-\d+)?)\/?$/i;

const VOLUME_RE = /\/volume-\d+\/?$/i;

const normalizePath = (input: string): string => {
  try {
    const url = new URL(input, SITE);

    if (url.hostname !== new URL(SITE).hostname) {
      return '';
    }

    return decodeURIComponent(url.pathname)
      .replace(/\/+/g, '/')
      .replace(/\/?$/, '/');
  } catch {
    return '';
  }
};

const getPage = async (input: string): Promise<string> => {
  const path = normalizePath(input);

  if (!path) {
    throw new Error(`Invalid AzzusaNovel URL: ${input}`);
  }

  const response = await fetchApi(`${SITE}${path}`);

  if (!response.ok) {
    throw new Error(`AzzusaNovel request failed: ${response.status} ${path}`);
  }

  return response.text();
};

const getContent = ($: CheerioAPI) => {
  const selectors = [
    'article .entry-content',
    '.entry-content',
    '.post-content',
    'article',
    'main',
  ];

  for (const selector of selectors) {
    const element = $(selector).first();

    if (element.length) {
      return element;
    }
  }

  return $('body');
};

const cleanText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const normalizeText = (value: string): string =>
  cleanText(value).toLowerCase().replace(/[’']/g, '');

const getNovel = (path: string) => {
  const normalized = normalizePath(path);

  return NOVELS.find(novel => normalizePath(novel.path) === normalized);
};

class AzzusaNovel implements Plugin.PluginBase {
  id = 'azzusanovel';
  name = 'AzzusaNovel';
  icon = 'src/id/azzusanovel/icon.webp';
  site = SITE;
  version = '1.1.1';

  async popularNovels(pageNo = 1): Promise<Plugin.NovelItem[]> {
    return pageNo === 1 ? NOVELS : [];
  }

  async searchNovels(
    searchTerm: string,
    pageNo = 1,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const query = normalizeText(searchTerm);

    if (!query) return NOVELS;

    return NOVELS.filter(novel => normalizeText(novel.name).includes(query));
  }

  private collectChapters(
    $: CheerioAPI,
    into: Map<string, Plugin.ChapterItem>,
  ) {
    const content = getContent($);

    content.find('a[href]').each((_, element) => {
      const anchor = $(element);
      const href = anchor.attr('href');

      if (!href) return;

      const path = normalizePath(href);

      if (!path || !CHAPTER_RE.test(path) || into.has(path)) {
        return;
      }

      const name = cleanText(
        anchor.text() ||
          anchor.attr('title') ||
          anchor.find('img').attr('alt') ||
          '',
      );

      if (!name) return;

      const number = name.match(/^(\d+)/);

      into.set(path, {
        name,
        path,
        chapterNumber: number ? Number.parseInt(number[1], 10) : undefined,
      });
    });
  }

  private collectVolumes($: CheerioAPI): string[] {
    const volumes = new Set<string>();

    getContent($)
      .find('a[href]')
      .each((_, element) => {
        const href = $(element).attr('href');

        if (!href) return;

        const path = normalizePath(href);

        if (path && VOLUME_RE.test(path)) {
          volumes.add(path);
        }
      });

    return [...volumes];
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const path = normalizePath(novelPath);

    if (!path) {
      throw new Error(`Invalid novel path: ${novelPath}`);
    }

    const html = await getPage(path);
    const $ = parseHTML(html);
    const content = getContent($);
    const known = getNovel(path);

    if (!content.text().trim()) {
      throw new Error(`Novel content not found: ${path}`);
    }

    const lines = content
      .find('p')
      .toArray()
      .flatMap(element => {
        const paragraph = $(element).clone();
        paragraph.find('br').replaceWith('\n');

        return paragraph.text().split('\n');
      })
      .map(cleanText)
      .filter(Boolean);

    const getField = (label: string): string => {
      const normalizedLabel = normalizeText(label);

      const line = lines.find(value =>
        normalizeText(value).startsWith(normalizedLabel),
      );

      if (!line) return '';

      return line.replace(/^[^:：]*[:：]\s*/, '').trim();
    };

    const synopsisIndex = lines.findIndex(value =>
      /^sinopsis\s*[:：]?/i.test(value),
    );

    let summary = '';

    if (synopsisIndex >= 0) {
      const synopsis: string[] = [];

      const first = lines[synopsisIndex]
        .replace(/^sinopsis\s*[:：]?\s*/i, '')
        .trim();

      if (first) synopsis.push(first);

      for (const line of lines.slice(synopsisIndex + 1)) {
        if (/^(baca web novel|chapter\s+\d|galeri)/i.test(line)) {
          break;
        }

        synopsis.push(line);
      }

      summary = synopsis.join('\n\n');
    }

    const statusText = normalizeText(getField('Status Terjemahan'));

    const status = /complete|tamat|selesai/.test(statusText)
      ? NovelStatus.Completed
      : statusText.includes('ongoing')
        ? NovelStatus.Ongoing
        : NovelStatus.Unknown;

    const name =
      known?.name ||
      cleanText(
        $('h1')
          .first()
          .text()
          .replace(/^Novel\s+/i, '')
          .replace(/\s+Bahasa Indonesia$/i, ''),
      );

    const cover =
      content.find('img').first().attr('data-src') ||
      content.find('img').first().attr('src') ||
      known?.cover ||
      '';

    const chapterMap = new Map<string, Plugin.ChapterItem>();

    this.collectChapters($, chapterMap);

    const volumePaths = this.collectVolumes($);

    const volumeResults = await Promise.all(
      volumePaths.map(async volumePath => {
        try {
          return await getPage(volumePath);
        } catch {
          return '';
        }
      }),
    );

    for (const volumeHTML of volumeResults) {
      if (!volumeHTML) continue;

      this.collectChapters(parseHTML(volumeHTML), chapterMap);
    }

    const chapters = [...chapterMap.values()].sort(
      (a, b) =>
        (a.chapterNumber ?? Number.MAX_SAFE_INTEGER) -
        (b.chapterNumber ?? Number.MAX_SAFE_INTEGER),
    );

    return {
      path,
      name,
      cover,
      author: getField('Pengarang'),
      genres: getField('Genre'),
      summary,
      status,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const path = normalizePath(chapterPath);

    if (!path || !CHAPTER_RE.test(path)) {
      throw new Error(`Invalid chapter path: ${chapterPath}`);
    }

    const html = await getPage(path);
    const $ = parseHTML(html);
    const content = getContent($);

    content
      .find(
        [
          'script',
          'style',
          'iframe',
          '#comments',
          '#jp-post-flair',
          '.sharedaddy',
          '.sd-sharing-enabled',
          '.jp-relatedposts',
          '.wpcnt',
          '.wpa',
          '.wp-block-embed',
        ].join(','),
      )
      .remove();

    content.find('a').each((_, element) => {
      const anchor = $(element);
      const label = cleanText(anchor.text());

      if (/^(?:<<\s*prev|home|next\s*>>)$/i.test(label)) {
        const parent = anchor.parent('p');

        anchor.remove();

        if (parent.length && /^[\s|·\-–]*$/.test(parent.text())) {
          parent.remove();
        }
      }
    });

    const result = content.html()?.trim() || '';

    if (!result) {
      throw new Error(`Chapter content not found: ${path}`);
    }

    return result;
  }
}

export default new AzzusaNovel();
