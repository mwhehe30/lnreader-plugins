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

const CHAPTER_RE = /\/(?:ch|orv-|tcf-|sclass-)\d+(?:-\d+)?\/?$/i;
const VOLUME_RE = /\/volume-\d+\/?$/i;

const toPath = (href: string): string => {
  if (
    /^(?:https?:)?\/\//i.test(href) &&
    !/^(?:https?:)?\/\/azzusanovel\.wordpress\.com/i.test(href)
  ) {
    return '';
  }

  const clean = href
    .split('#')[0]
    .split('?')[0]
    .replace(/^(?:https?:)?\/\/azzusanovel\.wordpress\.com/i, '');

  return clean.startsWith('/') ? clean : `/${clean}`;
};

const getPage = (path: string): Promise<string> =>
  fetchApi(path.startsWith('http') ? path : SITE + path).then(r => r.text());

const getContent = ($: CheerioAPI) => {
  for (const sel of ['.entry-content', '.post-content', 'article', 'main']) {
    const el = $(sel).first();
    if (el.length) return el;
  }

  return $('body');
};

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '');

class AzzusaNovel implements Plugin.PluginBase {
  id = 'azzusanovel';
  name = 'AzzusaNovel';
  icon = 'src/id/azzusanovel/icon.webp';
  site = SITE;
  version = '1.0.0';

  async popularNovels(pageNo = 1): Promise<Plugin.NovelItem[]> {
    return pageNo > 1 ? [] : NOVELS;
  }

  async searchNovels(
    searchTerm: string,
    pageNo = 1,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const q = norm(searchTerm.trim());

    return NOVELS.filter(n => norm(n.name).includes(q));
  }

  private collectChapters(
    $: CheerioAPI,
    into: Map<string, Plugin.ChapterItem>,
  ) {
    getContent($)
      .find('a[href]')
      .each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;

        const path = toPath(href);

        if (!CHAPTER_RE.test(path) || into.has(path)) return;

        const name = $(el).text().replace(/\s+/g, ' ').trim();
        if (!name) return;

        const m = name.match(/^\s*(\d+)/);

        into.set(path, {
          name,
          path,
          chapterNumber: m ? parseInt(m[1], 10) : undefined,
        });
      });
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = parseHTML(await getPage(novelPath));
    const content = getContent($);

    const known = NOVELS.find(n => n.path === novelPath);

    // Novel cover
    const cover =
      content.find('img').first().attr('src')?.split('?')[0] ||
      known?.cover ||
      '';

    // Novel information
    content.find('br').replaceWith('\n');

    const lines = content
      .find('p')
      .toArray()
      .flatMap(p => $(p).text().split('\n'))
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const field = (label: string) => {
      const line = lines.find(l => norm(l).startsWith(norm(label)));

      return line ? line.replace(/^[^:]*:\s*/, '').trim() : '';
    };

    // Synopsis
    let summary = '';

    const idx = lines.findIndex(l => /^sinopsis/i.test(l));

    if (idx >= 0) {
      const out: string[] = [];

      const first = lines[idx].replace(/^sinopsis\s*:?\s*/i, '').trim();

      if (first) out.push(first);

      for (const l of lines.slice(idx + 1)) {
        if (/^(baca web novel|chapter\s+\d|galeri)/i.test(l)) {
          break;
        }

        out.push(l);
      }

      summary = out.join('\n\n');
    }

    // Translation status
    const st = field('Status Terjemahan').toLowerCase();

    const status = /complete|tamat|selesai/.test(st)
      ? NovelStatus.Completed
      : st.includes('ongoing')
        ? NovelStatus.Ongoing
        : NovelStatus.Unknown;

    // Novel name
    const name =
      known?.name ||
      $('h1')
        .first()
        .text()
        .replace(/^Novel\s+/i, '')
        .replace(/\s+Bahasa Indonesia$/i, '')
        .trim();

    // Chapters
    const chapterMap = new Map<string, Plugin.ChapterItem>();

    this.collectChapters($, chapterMap);

    // Collect volume pages (ORV)
    const volumePaths = new Set<string>();

    content.find('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const path = toPath(href);

      if (VOLUME_RE.test(path)) {
        volumePaths.add(path);
      }
    });

    const volumePages = await Promise.all(
      [...volumePaths].map(p => getPage(p).catch(() => '')),
    );

    for (const html of volumePages) {
      if (html) {
        this.collectChapters(parseHTML(html), chapterMap);
      }
    }

    const chapters = [...chapterMap.values()].sort(
      (a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0),
    );

    return {
      path: novelPath,
      name,
      cover,
      author: field('Pengarang'),
      genres: field('Genre'),
      summary,
      status,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = parseHTML(await getPage(chapterPath));
    const content = getContent($);

    // Remove non-story elements
    content
      .find(
        'script, style, iframe, #comments, #jp-post-flair, .sharedaddy, .sd-sharing-enabled, .jp-relatedposts, .wpcnt, .wpa',
      )
      .remove();

    // Remove chapter navigation
    content.find('a').each((_, el) => {
      const a = $(el);

      const label = a.text().replace(/\s+/g, ' ').trim();

      if (/^(?:<<\s*prev|home|next\s*>>)$/i.test(label)) {
        const parent = a.parent('p');

        a.remove();

        if (parent.length && /^[\s|·\-–]*$/.test(parent.text())) {
          parent.remove();
        }
      }
    });

    return content.html() || '';
  }
}

export default new AzzusaNovel();
