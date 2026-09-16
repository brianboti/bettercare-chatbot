// Per-list extraction rules for the BetterCare SharePoint site.
//
// SharePoint list columns are named by whoever created them, so generic names
// (field_2, field_4, Yes) are unavoidable. Every mapping below was derived by
// reading actual row values, not column names. See DECODED notes.
//
// A list is either:
//   build(item, ctx) -> { title, body, meta, links }   indexed as content
//   lookup: true                                       used only to resolve ids
//   skip: '<reason>'                                   excluded, with the reason recorded

/** Shared builder for the six Q&A lists, which share an identical schema. */
const faq = (categoryList) => ({
  kind: 'faq',
  categoryList,
  build: (it, ctx) => {
    const { text, links } = ctx.html(it.Answers);
    return {
      title: it.Title,
      body: text,
      links,
      meta: { category: ctx.lookup(categoryList, it.CategoryId) },
    };
  },
});

/** Shared builder for dated milestone lists. */
const timeline = (label) => ({
  kind: 'event',
  build: (it, ctx) => ({
    title: it.Heading || it.Title,
    body: ctx.text(it.Description),
    meta: { date: it.Date ? it.Date.slice(0, 10) : undefined, series: label },
  }),
});

/**
 * Is the row visible on the live site?
 *
 * `Display` is a multi-choice column whose values are per-upgrade-wave:
 * "yes", "no", "Yes-vAug2024", "Yes-vNov2024", "Yes-vFeb2025", ... A row can
 * carry several at once (["Yes-vMay2024", "no"]), so any "yes*" value counts
 * as displayed. An absent column means the list does not gate on it.
 */
function isDisplayed(it) {
  const v = it.Display;
  if (v == null || v === '') return true;
  const values = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim().toLowerCase());
  return values.some((x) => x.startsWith('yes'));
}

export const LISTS = {
  // ---- Q&A -------------------------------------------------------------
  FAQQuestions:       faq('FAQCategories'),
  FAQsAbridge:        faq('FAQAbridgeCategory'),
  FAQWisdomQuestions: faq('FAQWisdomCategory'),
  DtlFAQs:            faq('DtlCatgFAQs'),
  DtlCrseJR:          faq('DtlCatg'),
  FAQThriveQuestions: faq('FAQCategories'),

  // ---- Glossary --------------------------------------------------------
  // DECODED: Title is empty on every row; the term lives in EpicTerm.
  // AxiumTerm (the legacy dental system) is present on only 5 of 12.
  Terminology: {
    kind: 'glossary',
    build: (it, ctx) => ({
      title: it.AxiumTerm
        ? `${it.EpicTerm} (axiUm equivalent: ${it.AxiumTerm})`
        : it.EpicTerm,
      body: ctx.text(it.Definition),
      meta: { epicTerm: it.EpicTerm, axiumTerm: it.AxiumTerm || undefined },
    }),
  },

  // ---- Upgrade / feature content --------------------------------------
  // DECODED: field_4 = description, field_1 = Epic application (HB/PB/Research),
  // field_2 + field_3 = audience and service-line tags. Notes holds editorial
  // bookkeeping ("no display per Kevin 11/13/24") and is deliberately excluded.
  // Multiple "Learn more" columns exist, one per upgrade wave.
  RefuelProjList: {
    kind: 'feature',
    published: isDisplayed,
    build: (it, ctx) => ({
      title: it.Title,
      body: [ctx.text(it.field_4), ctx.text(it.MSRHDescription)].filter(Boolean).join('\n\n'),
      links: ctx.links(it, ['Learnmore', 'vNov2024', 'vFeb2025', 'Aug', 'LM_x002d_vAug2024', 'Training']),
      meta: {
        application: it.field_1,
        audience: ctx.arr(it.field_2),
        serviceLine: ctx.arr(it.field_3),
        phase: ctx.arr(it.PhaseUpgrade),
        userImpact: it.UserImpact,
        affectedGroup: it.AffectedGroup,
      },
    }),
  },

  // DECODED: field_2 = description, field_3 = product tags, field_4 = audience,
  // ProSol = a problem/solution narrative present on one row.
  GenAI: {
    kind: 'feature',
    build: (it, ctx) => ({
      title: it.Title,
      body: [ctx.text(it.field_2), ctx.text(it.ProSol)].filter(Boolean).join('\n\n'),
      meta: { tags: ctx.arr(it.field_3), audience: ctx.arr(it.field_4), state: it.State },
    }),
  },
  // Same schema as GenAI and largely the same rows; deduped downstream by content hash.
  'GenAI-2': { kind: 'feature', sameAs: 'GenAI' },

  // DECODED: field_4 = one-line description ("Lab System"), Title = module name.
  EpicUpgrades: {
    kind: 'feature',
    published: isDisplayed,
    build: (it, ctx) => ({
      title: it.Title,
      body: ctx.text(it.field_4),
      links: ctx.links(it, ['Learnmore', 'vAugust2024']),
      meta: { phase: ctx.arr(it.PhaseUpgrade) },
    }),
  },

  // No description column at all — title + module + wave + link.
  UpgradesByModules: {
    kind: 'feature',
    build: (it, ctx) => ({
      title: it.Title,
      body: `${it.Title} — ${it.Module} module, ${it.UpgradeRefuel} upgrade.`,
      links: ctx.links(it, ['vNov2024']),
      meta: { module: it.Module, upgrade: it.UpgradeRefuel },
    }),
  },

  Timeline:           timeline('Epic implementation'),
  'Upgrade Timeline': timeline('Epic upgrade'),

  // ---- Resource pages (rich HTML with embedded links) ------------------
  'Resource Directory': {
    kind: 'resource',
    build: (it, ctx) => {
      const { text, links } = ctx.html(it.Links);
      return {
        title: it.Topic || it.Title,
        body: [ctx.text(it.Description), text].filter(Boolean).join('\n\n'),
        links,
        meta: { app: it.App, status: it.Status },
      };
    },
  },
  ACEResources: {
    kind: 'resource',
    build: (it, ctx) => {
      const { text, links } = ctx.html(it.Resources);
      return { title: it.Title, body: text, links };
    },
  },
  MetricsResources: {
    kind: 'resource',
    // TestCol duplicates DescResources on every row; ignored.
    build: (it, ctx) => {
      const { text, links } = ctx.html(it.DescResources);
      return {
        title: it.Title,
        body: [ctx.text(it.Desc), text].filter(Boolean).join('\n\n'),
        links: [...links, ...ctx.links(it, ['Link1', 'Link2'])],
      };
    },
  },

  // ---- Document catalogs ----------------------------------------------
  // These rows are *metadata about files*, not the file text. The bot can name
  // and link a tip sheet from these, but cannot answer from its contents until
  // the PDFs themselves are indexed.
  //
  // Document -> SharePoint PDF (53/53). This is the join key into Shared Documents.
  'Wisdom Document links': {
    kind: 'catalog',
    categoryList: 'WisdomTipSheetCategories',
    build: (it, ctx) => ({
      title: it.Title,
      body: `${it.Title} — Wisdom (revenue cycle) ${it.TrainingType} tip sheet.`,
      links: ctx.links(it, ['Document', 'TrainTrackLink']),
      meta: {
        roles: ctx.arr(it.Roles),
        category: ctx.lookup('WisdomTipSheetCategories', it.CatgId),
        format: it.TrainingType,
        documentUrl: ctx.url(it.Document),
      },
    }),
  },
  // DECODED: every TrainTrackLink points at the Ancile uPerform LMS
  // (uthscsa.ancileuperform.com), NOT SharePoint — unreachable for indexing.
  'Beaker-TipSheets': {
    kind: 'catalog',
    build: (it, ctx) => ({
      title: it.Title,
      body: `${it.Title} — Beaker (lab) ${it.TrainingType} tip sheet.`,
      links: ctx.links(it, ['TrainTrackLink']),
      meta: { groups: ctx.arr(it.Group), category: it.Category, format: it.TrainingType, external: true },
    }),
  },
  // DECODED: field_2 = format, field_3 = roles. Only 17 of 56 rows carry a link.
  WisdomTipSheets: {
    kind: 'catalog',
    build: (it, ctx) => ({
      title: String(it.Title || '').replace(/\.(pdf|docx?)$/i, ''),
      body: `${it.Title} — Wisdom ${it.field_2} tip sheet.`,
      links: ctx.links(it, ['TrainTrackLink']),
      meta: { roles: ctx.arr(it.field_3), format: it.field_2 },
    }),
  },
  'JTC Tips Sheets': {
    kind: 'catalog',
    build: (it, ctx) => ({
      title: it.Title,
      body: `${it.Title} — tip sheet.`,
      links: ctx.links(it, ['Link']),
    }),
  },

  // ---- Lookup tables (resolve CategoryId / CatgId; never indexed) -------
  FAQCategories:            { lookup: true },
  FAQWisdomCategory:        { lookup: true },
  FAQAbridgeCategory:       { lookup: true },
  DtlCatg:                  { lookup: true },
  DtlCatgFAQs:              { lookup: true },
  WisdomTipSheetCategories: { lookup: true },

  // ---- Excluded --------------------------------------------------------
  HOPD:            { skip: 'Placeholder data - lorem ipsum descriptions, all links point to google.com.' },
  'Breaking News': { skip: 'Placeholder data - every row is only a title, "Breaking New 1".."Breaking New 33".' },
  Abridge:         { skip: 'Navigation menu (Title/PageLink/Icon), not content. Usable later as a sitemap into Site Pages.' },
};
